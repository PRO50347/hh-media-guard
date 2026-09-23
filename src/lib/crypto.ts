import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SafeError } from "./safe-error";

function key(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded)
    throw new SafeError(
      "encryption.missing",
      "ENCRYPTION_KEY is required. Configure a stable 32-byte base64 value before starting Media Guard.",
    );
  const value = Buffer.from(encoded, "base64");
  if (value.toString("base64") !== encoded)
    throw new SafeError(
      "encryption.malformed",
      "ENCRYPTION_KEY is malformed; use canonical base64 for a 32-byte key.",
    );
  if (value.length !== 32)
    throw new SafeError(
      "encryption.length",
      "ENCRYPTION_KEY has incorrect decoded length; a 32-byte key is required.",
    );
  return value;
}
export function validateEncryptionKey() {
  key();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    payload.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  try {
    const [ivText, tagText, valueText] = payload.split(".");
    if (!ivText || !tagText || !valueText)
      throw new Error("Stored credential is invalid.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivText, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(valueText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SafeError(
      "credential.decrypt",
      "Stored credential cannot be decrypted. Restore the original ENCRYPTION_KEY or re-enter the API key.",
    );
  }
}
