import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

const original = process.env.ENCRYPTION_KEY;
afterEach(() => {
  if (original) process.env.ENCRYPTION_KEY = original;
  else delete process.env.ENCRYPTION_KEY;
});
describe("credential encryption", () => {
  it("round-trips a credential without preserving plaintext", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("secret-value");
    expect(encrypted).not.toContain("secret-value");
    expect(decryptSecret(encrypted)).toBe("secret-value");
  });
  it("rejects missing encryption material", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow("ENCRYPTION_KEY");
  });
  it("rejects invalid encryption material", () => {
    process.env.ENCRYPTION_KEY = "short";
    expect(() => encryptSecret("x")).toThrow("32-byte");
  });
  it("detects tampered ciphertext", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const encrypted = encryptSecret("x");
    const [iv, tag, data] = encrypted.split(".");
    const tampered = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
    expect(() => decryptSecret(`${iv}.${tampered}.${data}`)).toThrow();
  });
});
