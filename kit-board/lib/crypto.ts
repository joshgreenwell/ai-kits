import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);

export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function safeEqual(a: string, b: string) { return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex')); }
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, hash] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hash ?? '')) return false;
  const result = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(result, Buffer.from(hash, 'hex'));
}
export function issueSession(secret: string, passwordHash: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ expires: now + 7 * 86400_000, nonce: randomBytes(16).toString('hex'), passwordVersion: digest(passwordHash) })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifySession(token: string, secret: string, passwordHash: string, now = Date.now()) {
  if (!secret || !passwordHash || token.length > 2048) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], createHmac('sha256', secret).update(parts[0]).digest('base64url'))) return false;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return typeof value.expires === 'number' && value.expires > now && value.expires <= now + 7 * 86400_000 && value.passwordVersion === digest(passwordHash);
  } catch { return false; }
}
