import { verifyToken } from '../lib/auth.js';

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Rejects the request unless a valid token is present. */
export function requireAuth(req, res, next) {
  const token = readToken(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  req.user = { id: payload.sub, email: payload.email, name: payload.name };
  next();
}

/**
 * Attaches req.user when a valid token is present, but allows the request
 * through either way. Used on analysis endpoints so they stay explorable while
 * logged out, sizing against a neutral default portfolio instead of yours.
 */
export function optionalAuth(req, _res, next) {
  const token = readToken(req);
  const payload = token ? verifyToken(token) : null;
  if (payload) req.user = { id: payload.sub, email: payload.email, name: payload.name };
  next();
}
