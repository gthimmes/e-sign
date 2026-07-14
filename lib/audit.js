// Audit-trail + integrity helpers. These are what make the signatures
// legally defensible under the U.S. ESIGN Act / UETA: a durable record of
// who did what, when, from where, plus a tamper-evident document hash.
import crypto from 'node:crypto';
import db from '../db.js';

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

// Opaque, unguessable signing token for a recipient's link.
export const newToken = () => crypto.randomBytes(24).toString('base64url');

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const insertEvent = db.prepare(`
  INSERT INTO audit_events (id, document_id, recipient_id, event_type, detail, ip, user_agent, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Record one audit event. `req` is optional (used to capture IP + user agent).
export function logEvent(documentId, { recipientId = null, type, detail = null, req = null }) {
  insertEvent.run(
    newId(),
    documentId,
    recipientId,
    type,
    detail,
    req ? clientIp(req) : null,
    req ? (req.get('user-agent') || null) : null,
    nowIso()
  );
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function getEvents(documentId) {
  return db
    .prepare('SELECT * FROM audit_events WHERE document_id = ? ORDER BY created_at ASC')
    .all(documentId);
}
