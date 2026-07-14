// Sender authentication: local accounts, scrypt-hashed passwords, and
// server-side sessions carried in an httpOnly cookie. Signer links are token-based
// and remain public — only the authoring/dashboard side requires an account.
import crypto from 'node:crypto';
import db from '../db.js';
import { newId, nowIso } from './audit.js';

const COOKIE = 'inkwell_sid';
const SESSION_DAYS = 14;

// ---- password hashing (scrypt) ------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const hash = Buffer.from(hashHex, 'hex');
  const test = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), hash.length);
  return crypto.timingSafeEqual(hash, test);
}

// ---- users ---------------------------------------------------------------

export function createUser({ email, name, password }) {
  const id = newId();
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, email.toLowerCase().trim(), name?.trim() || null, hashPassword(password), nowIso()
  );
  return getUserById(id);
}

export const getUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
export const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

// ---- sessions ------------------------------------------------------------

export function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    id, userId, nowIso(), expires
  );
  return { id, expires };
}

export function destroySession(id) {
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function userForSession(sid) {
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  return getUserById(s.user_id);
}

// ---- cookie helpers ------------------------------------------------------

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function setSessionCookie(res, session) {
  res.cookie(COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    expires: new Date(session.expires),
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// ---- middleware ----------------------------------------------------------

// Attaches req.user (or null). Never blocks.
export function loadUser(req, _res, next) {
  req.sessionId = parseCookies(req)[COOKIE] || null;
  req.user = userForSession(req.sessionId);
  next();
}

// Blocks unauthenticated requests to authoring routes.
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
