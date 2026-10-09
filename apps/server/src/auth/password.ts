import argon2 from 'argon2';

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  return email;
}
export function validatePassword(value: string) {
  if (value.length < 12 || value.length > 128) throw new Error('Password must contain 12–128 characters');
}
export function hashPassword(password: string) {
  validatePassword(password);
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}
export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
