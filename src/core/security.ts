import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const N = 65536,
  r = 8,
  p = 1,
  bytes = 64;
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, bytes, { N, r, p, maxmem: 128 * 1024 * 1024 }, (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', N, r, p, salt.toString('hex'), key.toString('hex')].join('$');
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    Number(parts[1]) !== N ||
    Number(parts[2]) !== r ||
    Number(parts[3]) !== p ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{128}$/.test(parts[5])
  )
    return false;
  const actual = await derive(password, Buffer.from(parts[4], 'hex'));
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}
export async function dummyPasswordCheck(password: string) {
  await derive(password, Buffer.alloc(16, 0));
}
