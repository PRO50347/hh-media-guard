import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDiagnostics,
  validateConfig,
  startupFailure,
} from "../src/lib/startup";
import {
  validateEncryptionKey,
  encryptSecret,
  decryptSecret,
} from "../src/lib/crypto";
import { allowedOrigins, validateOrigin } from "../src/lib/origin";
import { SafeError, safeMessage } from "../src/lib/safe-error";
import { networkError } from "../src/lib/arr-transport";
import { runtimeId, checkMounts } from "../scripts/config-init.mjs";
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
describe("startup diagnostics and secrets", () => {
  it("identifies missing config and UID/GID without creating it", () => {
    const p = path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`);
    expect(configDiagnostics(p)).toMatchObject({
      CONFIG_PATH: p,
      CONFIG_EXISTS: false,
      CONFIG_WRITABLE: false,
      RUNTIME_UID: process.getuid?.(),
      RUNTIME_GID: process.getgid?.(),
    });
    expect(() => validateConfig(p)).toThrow("does not exist");
    expect(fs.existsSync(p)).toBe(false);
  });
  it("validates fresh and existing writable config without losing files", () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "mg-start-"));
    try {
      validateConfig(p);
      fs.writeFileSync(path.join(p, "proof"), "keep");
      validateConfig(p);
      expect(fs.readdirSync(p)).toEqual(["proof"]);
    } finally {
      fs.rmSync(p, { recursive: true });
    }
  });
  it.each([
    ["", "encryption.missing"],
    ["not!base64", "encryption.malformed"],
    [Buffer.alloc(16).toString("base64"), "encryption.length"],
  ])("classifies key error without value (%s)", (value, code) => {
    process.env.ENCRYPTION_KEY = value;
    try {
      validateEncryptionKey();
      throw new Error("expected rejection");
    } catch (error) {
      expect(startupFailure(error).code).toBe(code);
      if (value)
        expect(JSON.stringify(startupFailure(error))).not.toContain(value);
    }
  });
  it("keeps authenticated ciphertext stable across same-key reload and fails safely with wrong key", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    const cipher = encryptSecret("private-api-credential");
    expect(decryptSecret(cipher)).toBe("private-api-credential");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    expect(() => decryptSecret(cipher)).toThrow("cannot be decrypted");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    expect(decryptSecret(cipher)).toBe("private-api-credential");
  });
  it("never prints unknown exception messages", () => {
    const e = new Error("password token cookie ENCRYPTION_KEY=private-secret");
    expect(JSON.stringify(startupFailure(e))).not.toContain("private-secret");
    expect(safeMessage(e)).not.toContain("private-secret");
  });
  it("distinguishes database and lease errors", () => {
    for (const code of ["database.open", "runtime.conflict"])
      expect(startupFailure(new SafeError(code, "Safe guidance")).code).toBe(
        code,
      );
  });
  it("defaults allowed origins to APP_URL and supports explicit HTTPS proxy origins", () => {
    process.env.APP_URL = "http://server.example:3938";
    delete process.env.ALLOWED_ORIGINS;
    expect(allowedOrigins()).toEqual(["http://server.example:3938"]);
    process.env.ALLOWED_ORIGINS = "https://media.example.com";
    expect(() => validateOrigin("https://media.example.com")).not.toThrow();
    expect(() => validateOrigin("https://attacker.example.com")).toThrow();
  });
  it.each(["APP_URL", "ALLOWED_ORIGINS"])(
    "identifies invalid %s without reflecting secrets",
    (field) => {
      process.env.APP_URL = "https://media.example.com";
      process.env[field] = "https://user:private-password@host/path";
      try {
        allowedOrigins();
        throw new Error("expected");
      } catch (e) {
        expect(safeMessage(e)).toContain(field);
        expect(safeMessage(e)).not.toContain("private-password");
      }
    },
  );
});
describe("scoped config bootstrap", () => {
  it.each(["0", "-1", "abc", "1:2", "4294967295", " 99", "99.5", ""])(
    "rejects unsafe ID %s",
    (id) => expect(() => runtimeId(id, 100)).toThrow(),
  );
  it("keeps legacy defaults and accepts Unraid IDs", () => {
    expect(runtimeId(undefined, 100)).toBe(100);
    expect(runtimeId("99", 100)).toBe(99);
  });
  const mounts =
    "1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /appdata/guard /config rw - ext4 /dev/test rw\n3 1 8:1 /library /Media ro - ext4 /dev/test ro";
  it("permits independent appdata/media mounts", () =>
    expect(() =>
      checkMounts(mounts, ["/Media", "/movies", "/tv"]),
    ).not.toThrow());
  it.each(["/config", "/config/media", "/", "/config/../config"])(
    "rejects media overlap %s",
    (root) => expect(() => checkMounts(mounts, [path.resolve(root)])).toThrow(),
  );
  it("rejects alternate bind alias to the same host storage", () =>
    expect(() =>
      checkMounts(mounts.replace("/library /Media", "/appdata/guard /Media"), [
        "/Media",
      ]),
    ).toThrow());
  it("rejects nested media mounts before any ownership changes", () =>
    expect(() =>
      checkMounts(
        mounts + "\n4 2 8:1 /library /config/branding ro - ext4 /dev/test ro",
        ["/Media"],
      ),
    ).toThrow());
});
describe("sanitized Arr failures", () => {
  it.each([
    ["ENOTFOUND", "DNS"],
    ["EAI_AGAIN", "DNS"],
    ["ECONNREFUSED", "refused"],
    ["ENETUNREACH", "unreachable"],
    ["EHOSTUNREACH", "unreachable"],
    ["ETIMEDOUT", "timed out"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS"],
    ["ECONNRESET", "connection failed"],
  ])("classifies %s without exception content", (code, message) => {
    const e = Object.assign(new Error("secret-key-in-url"), { code });
    expect(networkError(e).message).toContain(message);
    expect(networkError(e).message).not.toContain("secret-key-in-url");
  });
});
