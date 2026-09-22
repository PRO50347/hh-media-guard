import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error('ENCRYPTION_KEY is required before saving integration credentials.');
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32) throw new Error('ENCRYPTION_KEY must be a 32-byte base64 value.');
  return value;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), payload.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivText, tagText, valueText] = payload.split('.');
  if (!ivText || !tagText || !valueText) throw new Error('Stored credential is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(valueText, 'base64')), decipher.final()]).toString('utf8');
}
