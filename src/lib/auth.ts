import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies, headers } from "next/headers";
import { raw, audit } from "./store";
import { validateCsrf, validateOrigin } from "./origin";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, value] = stored.split(":");
  if (!salt || !/^[a-f0-9]{128}$/.test(value || "")) return false;
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(value, "hex"),
  );
}
export function hasAdmin() {
  return Boolean(raw().prepare("SELECT 1 FROM users LIMIT 1").get());
}
export function createAdmin(username: string, password: string) {
  const digest = passwordHash(password);
  raw()
    .transaction(() => {
      if (hasAdmin()) throw new Error("An administrator already exists");
      raw()
        .prepare("INSERT INTO users VALUES(?,?,?,?)")
        .run(
          randomBytes(16).toString("hex"),
          username,
          digest,
          new Date().toISOString(),
        );
      audit("authentication", "Administrator created");
    })
    .immediate();
}
export function allowLogin(username: string, now = Date.now()) {
  return raw()
    .transaction(() => {
      raw().prepare("DELETE FROM auth_attempts WHERE expires_at<=?").run(now);
      for (const [key, limit] of [
        ["global", 60],
        [hash(username.toLowerCase()), 10],
      ] as const) {
        const row = raw()
          .prepare("SELECT attempts FROM auth_attempts WHERE id=?")
          .get(key) as { attempts: number } | undefined;
        if (row && row.attempts >= limit) return false;
      }
      for (const key of ["global", hash(username.toLowerCase())])
        raw()
          .prepare(
            "INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1",
          )
          .run(key, now + 300000);
      return true;
    })
    .immediate();
}
export function login(username: string, password: string) {
  const user = raw()
    .prepare("SELECT id,password_hash FROM users WHERE username=?")
    .get(username) as { id: string; password_hash: string } | undefined;
  // Equal-cost work for missing accounts reduces username timing disclosure.
  if (!user) {
    scryptSync(password, "missing-account-salt", 64);
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + 12 * 3600000).toISOString();
  raw()
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run(randomBytes(16).toString("hex"), user.id, hash(token), csrf, expires);
  audit("authentication", "Administrator signed in", username);
  return { token, csrf, expires };
}
export function sessionForToken(token: string) {
  return raw()
    .prepare(
      "SELECT sessions.csrf_token,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?",
    )
    .get(hash(token), new Date().toISOString()) as
    | { csrf_token: string; username: string }
    | undefined;
}
export async function currentSession() {
  const token = (await cookies()).get("mg_session")?.value;
  return token ? sessionForToken(token) : undefined;
}
export async function requireAdmin(write = false) {
  const session = await currentSession();
  if (!session) throw new Error("Authentication required");
  if (write) {
    const h = await headers();
    validateOrigin(h.get("origin"));
    validateCsrf(h.get("x-csrf-token"), session.csrf_token);
  }
  return session;
}
export function logout(token?: string) {
  if (token)
    raw().prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
}
