// Password hashing and token issuance.
//
// Passwords use scrypt from node's crypto module — a memory-hard KDF designed
// for exactly this, with no native build step and no third-party dependency.
// Verification is a timing-safe comparison. Tokens are standard HS256 JWTs.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // ~100ms on commodity hardware

/** Returns "salt:hash", both hex. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `${salt}:${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  // Length check first: timingSafeEqual throws on a mismatch.
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

/**
 * The signing secret. In development a stable per-machine secret is derived so
 * sessions survive a restart; production must supply JWT_SECRET explicitly.
 */
function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return crypto.createHash('sha256').update(`dev-secret:${process.cwd()}`).digest('hex');
}

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id ?? user._id), email: user.email, name: user.name },
    secret(),
    { expiresIn: '30d' },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret());
  } catch {
    return null;
  }
}

export function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 200) return 'Password is too long';
  return null;
}
