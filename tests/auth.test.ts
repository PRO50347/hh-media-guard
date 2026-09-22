import { beforeEach, describe, expect, it } from "vitest";
import {
  allowLogin,
  createAdmin,
  login,
  logout,
  sessionForToken,
} from "../src/lib/auth";
import { raw } from "../src/lib/store";
import { validateOrigin, validateCsrf } from "../src/lib/origin";
beforeEach(() => {
  raw().exec(
    "DELETE FROM sessions; DELETE FROM users; DELETE FROM auth_attempts",
  );
  process.env.APP_URL = "http://localhost:3938";
  delete process.env.ALLOWED_ORIGINS;
});
describe("administrator sessions", () => {
  it("hashes passwords and session tokens, revokes logout", () => {
    createAdmin("admin", "long test password");
    const session = login("admin", "long test password")!;
    expect(sessionForToken(session.token)?.username).toBe("admin");
    expect(raw().prepare("SELECT password_hash FROM users").get()).not.toEqual({
      password_hash: "long test password",
    });
    expect(raw().prepare("SELECT token_hash FROM sessions").get()).not.toEqual({
      token_hash: session.token,
    });
    logout(session.token);
    expect(sessionForToken(session.token)).toBeUndefined();
  });
  it("prevents subsequent administrator bootstrap", () => {
    createAdmin("admin", "long test password");
    expect(() => createAdmin("other", "another password")).toThrow(
      "already exists",
    );
  });
  it("rejects bad passwords and expired sessions", () => {
    createAdmin("admin", "long test password");
    expect(login("admin", "wrong password")).toBeNull();
    const session = login("admin", "long test password")!;
    raw().exec("UPDATE sessions SET expires_at='2000-01-01'");
    expect(sessionForToken(session.token)).toBeUndefined();
  });
  it("rate limits and expires attempts", () => {
    for (let i = 0; i < 10; i++) expect(allowLogin("admin", 1000)).toBe(true);
    expect(allowLogin("admin", 1000)).toBe(false);
    expect(allowLogin("admin", 301001)).toBe(true);
  });
});
describe("browser request boundaries", () => {
  it("accepts only exact origins and never uses Host", () => {
    expect(() => validateOrigin("http://localhost:3938")).not.toThrow();
    for (const origin of [
      null,
      "http://localhost:3938.evil.test",
      "https://evil.test",
      "null",
    ])
      expect(() => validateOrigin(origin)).toThrow();
    process.env.ALLOWED_ORIGINS = "https://guard.example";
    expect(() => validateOrigin("https://guard.example")).not.toThrow();
  });
  it("rejects wildcard origin configuration", () => {
    process.env.ALLOWED_ORIGINS = "https://*.example";
    expect(() => validateOrigin("https://a.example")).toThrow();
  });
  it("requires the session CSRF token", () => {
    expect(() => validateCsrf(null, "secret")).toThrow();
    expect(() => validateCsrf("wrong", "secret")).toThrow();
    expect(() => validateCsrf("secret", "secret")).not.toThrow();
  });
});
