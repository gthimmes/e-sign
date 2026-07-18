import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

import db, { transaction } from './db.js';
import { newId, newToken, nowIso, sha256, logEvent, clientIp, getEvents } from './lib/audit.js';
import { buildFinalPdf } from './lib/pdfStamp.js';
import { ensureSigningCert, getCertInfo, sealPdf } from './lib/pki.js';
import { timestamp } from './lib/tsa.js';
import {
  createUser, getUserByEmail, verifyPassword, hashPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, loadUser, requireAuth,
} from './lib/auth.js';
import { sendInvitation, sendCompletion, sendDeclined, sendReminder, sendPasswordReset, emailMode } from './lib/email.js';
import { rateLimit } from './lib/ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.INKWELL_UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

ensureSigningCert(); // generate the signing cert on first boot

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use(loadUser);
app.use(express.static(path.join(__dirname, 'public')));

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Signing links expire this many days after send; reminders mint fresh links
// for expired signers automatically.
const LINK_EXPIRY_DAYS = Number(process.env.LINK_EXPIRY_DAYS) || 30;
const newExpiry = () => new Date(Date.now() + LINK_EXPIRY_DAYS * 864e5).toISOString();
const linkExpired = (r) =>
  r.status !== 'signed' && !!r.token_expires_at && Date.parse(r.token_expires_at) < Date.now();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname) || '.pdf'}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

// ---- helpers -------------------------------------------------------------

const q = {
  doc: db.prepare('SELECT * FROM documents WHERE id = ?'),
  docs: db.prepare('SELECT * FROM documents ORDER BY created_at DESC'),
  recips: db.prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY signing_order, name'),
  recipByToken: db.prepare('SELECT * FROM recipients WHERE token = ?'),
  fields: db.prepare('SELECT * FROM fields WHERE document_id = ? ORDER BY page'),
  fieldsForRecip: db.prepare('SELECT * FROM fields WHERE recipient_id = ? ORDER BY page'),
};

// Never expose the access-code hash; surface only whether a code is set.
function publicRecipient(r) {
  const { access_code_hash, ...rest } = r;
  return { ...rest, has_access_code: !!access_code_hash, link_expired: linkExpired(r) };
}

function docPayload(id) {
  const document = q.doc.get(id);
  if (!document) return null;
  return {
    document,
    recipients: q.recips.all(id).map(publicRecipient),
    fields: q.fields.all(id),
  };
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Fetch a document the current user owns, or send 404/403. Legacy documents with
// no owner (created before auth) are claimable by any signed-in user.
function ownedDoc(req, res) {
  const d = q.doc.get(req.params.id);
  if (!d) { res.status(404).json({ error: 'Not found' }); return null; }
  if (d.owner_id && d.owner_id !== req.user.id) { res.status(403).json({ error: 'Not your document.' }); return null; }
  return d;
}

// ---- auth ----------------------------------------------------------------

// Throttle credential endpoints per IP to blunt brute-force / enumeration.
// The env overrides exist for the test suite, which makes many rapid calls.
const authLimiter = rateLimit({
  max: Number(process.env.AUTH_RATE_MAX) || 10,
  windowMs: 5 * 60_000,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
// Throttle signer-token endpoints (guessing tokens / hammering submit).
const signLimiter = rateLimit({ max: Number(process.env.SIGN_RATE_MAX) || 60, windowMs: 60_000 });

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name } : null, emailMode });
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const user = createUser({ email, name, password });
  const session = createSession(user.id);
  setSessionCookie(res, session);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(email || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const session = createSession(user.id);
  setSessionCookie(res, session);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req.sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Request a password reset. Always answers 200 so the endpoint can't be used
// to enumerate accounts; a reset link is emailed only if the account exists.
app.post('/api/auth/forgot', authLimiter, asyncH(async (req, res) => {
  const user = getUserByEmail(String(req.body?.email || ''));
  if (user) {
    const token = newToken();
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id); // one active reset at a time
    db.prepare('INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId(), user.id, sha256(Buffer.from(token)), nowIso(), new Date(Date.now() + 60 * 60_000).toISOString());
    const url = `${baseUrl(req)}/reset.html?t=${token}`;
    try {
      await sendPasswordReset({ user, url });
    } catch (e) {
      console.error('reset email failed for', user.email, e.message);
    }
  }
  res.json({ ok: true, emailMode });
}));

// Complete a password reset with the emailed token.
app.post('/api/auth/reset', authLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash=?')
    .get(sha256(Buffer.from(String(token || ''))));
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }
  transaction(() => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), row.user_id);
    db.prepare('UPDATE password_resets SET used_at=? WHERE id=?').run(nowIso(), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id); // sign out everywhere
  });
  res.json({ ok: true });
});

// Update display name.
app.put('/api/auth/profile', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name || null, req.user.id);
  res.json({ user: { id: req.user.id, email: req.user.email, name: name || null } });
});

// Change password: requires the current password; revokes every other session.
app.put('/api/auth/password', requireAuth, authLimiter, (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'Your current password is incorrect.' });
  }
  if (!next || next.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next), req.user.id);
  const revoked = db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(req.user.id, req.sessionId);
  res.json({ ok: true, revokedSessions: revoked.changes });
});

// Everything under /api/documents (authoring) requires a signed-in user.
app.use('/api/documents', requireAuth);
app.use('/api/templates', requireAuth);

// ---- templates (reusable field layouts) ----------------------------------

const FIELD_TYPE_SET = new Set(['signature', 'initials', 'date', 'name', 'text', 'checkbox', 'dropdown', 'radio']);

app.get('/api/templates', (req, res) => {
  const rows = db.prepare('SELECT * FROM templates WHERE owner_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ templates: rows.map((t) => ({ ...t, fields: JSON.parse(t.fields) })) });
});

// Save a layout. Fields reference signers by 1-based role so a template is
// independent of any particular document's recipients.
app.post('/api/templates', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'A template name is required.' });
  const raw = Array.isArray(req.body?.fields) ? req.body.fields : [];
  if (!raw.length) return res.status(400).json({ error: 'A template needs at least one field.' });
  const fields = raw.slice(0, 200).map((f) => {
    if (!FIELD_TYPE_SET.has(f.type)) return null;
    return {
      role: Math.max(1, Math.floor(Number(f.role) || 1)),
      page: Math.max(1, Math.floor(Number(f.page) || 1)),
      type: f.type,
      x_ratio: clamp(f.x_ratio), y_ratio: clamp(f.y_ratio),
      w_ratio: clamp(f.w_ratio), h_ratio: clamp(f.h_ratio),
      required: f.required !== false,
      options: JSON.parse(normalizeOptions(f.type, f.options) || 'null'),
    };
  }).filter(Boolean);
  if (!fields.length) return res.status(400).json({ error: 'No valid fields in template.' });
  const id = newId();
  db.prepare('INSERT INTO templates (id, owner_id, name, fields, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, name, JSON.stringify(fields), nowIso());
  res.json({ template: { id, name, fields } });
});

app.delete('/api/templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
  if (!t || t.owner_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM templates WHERE id=?').run(t.id);
  res.json({ ok: true });
});

// ---- document authoring --------------------------------------------------

app.post(
  '/api/documents',
  upload.single('pdf'),
  asyncH(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A PDF file is required.' });
    const bytes = await fsp.readFile(req.file.path);
    // Validate it really is a loadable PDF and grab a page count.
    let pageCount = 0;
    try {
      pageCount = (await PDFDocument.load(bytes)).getPageCount();
    } catch {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'That file could not be read as a PDF.' });
    }
    const id = newId();
    const title = (req.body.title || req.file.originalname.replace(/\.pdf$/i, '')).slice(0, 200);
    db.prepare(
      `INSERT INTO documents (id, title, original_name, file_path, status, created_at, owner_id)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`
    ).run(id, title, req.file.originalname, req.file.path, nowIso(), req.user.id);
    logEvent(id, { type: 'document.created', detail: `${title} (${pageCount} pages)`, req });
    res.json({ id, pageCount });
  })
);

// List documents with optional search (?q=), status filter (?status=), and
// an archived view (?archived=1). The default list hides archived docs.
app.get('/api/documents', (req, res) => {
  const term = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();
  const showArchived = req.query.archived === '1';
  const rows = q.docs.all()
    .filter((d) => !d.owner_id || d.owner_id === req.user.id)
    .filter((d) => (showArchived ? !!d.archived_at : !d.archived_at))
    .filter((d) => !status || d.status === status)
    .map((d) => {
      const recips = q.recips.all(d.id);
      return {
        ...d,
        signers: recips.length,
        signed: recips.filter((r) => r.status === 'signed').length,
        _haystack: `${d.title} ${d.original_name} ${recips.map((r) => `${r.name} ${r.email}`).join(' ')}`.toLowerCase(),
      };
    })
    .filter((d) => !term || d._haystack.includes(term))
    .map(({ _haystack, ...d }) => d);
  res.json(rows);
});

// Permanently delete a draft (sent/completed docs are legal records — archive
// or void those instead). Removes the uploaded file and, via FK cascades, all
// recipients/fields/audit rows.
app.delete('/api/documents/:id', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (d.status !== 'draft') {
    return res.status(409).json({ error: 'Only drafts can be deleted. Void or archive sent documents instead.' });
  }
  db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
  fs.promises.unlink(d.file_path).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/documents/:id/archive', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  db.prepare('UPDATE documents SET archived_at=? WHERE id=?').run(nowIso(), d.id);
  logEvent(d.id, { type: 'document.archived', req });
  res.json({ ok: true });
});

app.post('/api/documents/:id/unarchive', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  db.prepare('UPDATE documents SET archived_at=NULL WHERE id=?').run(d.id);
  logEvent(d.id, { type: 'document.unarchived', req });
  res.json({ ok: true });
});

app.get('/api/documents/:id', (req, res) => {
  if (!ownedDoc(req, res)) return;
  res.json(docPayload(req.params.id));
});

// Serve the original PDF bytes (authoring / preview).
app.get('/api/documents/:id/file', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  res.type('application/pdf').sendFile(d.file_path);
});

// Save recipients + field placements. Only allowed while in draft.
app.put('/api/documents/:id/prepare', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (d.status !== 'draft') return res.status(409).json({ error: 'Document already sent.' });

  const { recipients = [], fields = [] } = req.body;
  if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient.' });

  // Optional CC list: notified (not signers) when the document completes.
  let ccList = null;
  if (req.body.cc != null) {
    const raw = Array.isArray(req.body.cc) ? req.body.cc.slice(0, 20) : [];
    const cc = raw.map((c) => ({ name: String(c?.name || '').trim(), email: String(c?.email || '').trim() }))
      .filter((c) => c.email);
    const badCc = cc.find((c) => !EMAIL_RE.test(c.email));
    if (badCc) return res.status(400).json({ error: `“${badCc.email}” is not a valid CC email.` });
    ccList = cc.length ? JSON.stringify(cc) : null;
  }

  // Access codes are write-only: a save either sets a new code, keeps the one
  // already stored for that email (keep_code), or clears it. Snapshot existing
  // hashes before the delete-and-recreate below.
  const prevCodeByEmail = {};
  for (const r of q.recips.all(d.id)) {
    if (r.access_code_hash) prevCodeByEmail[r.email.toLowerCase()] = r.access_code_hash;
  }
  for (const r of recipients) {
    if (r.access_code != null && r.access_code !== '' &&
        (String(r.access_code).length < 4 || String(r.access_code).length > 64)) {
      return res.status(400).json({ error: 'Access codes must be 4–64 characters.' });
    }
  }

  transaction(() => {
    db.prepare('DELETE FROM fields WHERE document_id = ?').run(d.id);
    db.prepare('DELETE FROM recipients WHERE document_id = ?').run(d.id);

    // Map the client's temporary recipient keys to real ids.
    const idFor = {};
    const insRecip = db.prepare(
      `INSERT INTO recipients (id, document_id, name, email, signing_order, token, status, access_code_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    recipients.forEach((r, i) => {
      const rid = newId();
      idFor[r.key ?? r.id ?? i] = rid;
      const email = (r.email || '').trim();
      const codeHash = r.access_code
        ? hashPassword(String(r.access_code))
        : (r.keep_code ? prevCodeByEmail[email.toLowerCase()] || null : null);
      insRecip.run(rid, d.id, (r.name || '').trim(), email, Number(r.signing_order) || i + 1, newToken(), codeHash);
    });

    const insField = db.prepare(
      `INSERT INTO fields (id, document_id, recipient_id, page, type, x_ratio, y_ratio, w_ratio, h_ratio, required, options, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fields) {
      const rid = idFor[f.recipientKey];
      if (!rid) continue;
      insField.run(
        newId(), d.id, rid, Number(f.page), f.type,
        clamp(f.x_ratio), clamp(f.y_ratio), clamp(f.w_ratio), clamp(f.h_ratio),
        f.required === false ? 0 : 1, normalizeOptions(f.type, f.options), nowIso()
      );
    }
  });
  db.prepare('UPDATE documents SET cc_list=? WHERE id=?').run(ccList, d.id);
  logEvent(d.id, { type: 'document.prepared', detail: `${recipients.length} recipient(s), ${fields.length} field(s)${ccList ? `, ${JSON.parse(ccList).length} cc` : ''}`, req });
  res.json(docPayload(d.id));
});

// Send for signature: lock the document, hash it, mint links, email whoever's turn.
app.post('/api/documents/:id/send', asyncH(async (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (d.status !== 'draft') return res.status(409).json({ error: 'Already sent.' });
  const recips = q.recips.all(d.id);
  if (!recips.length) return res.status(400).json({ error: 'Nothing to send.' });
  const allFields = q.fields.all(d.id);
  const withoutField = recips.filter((r) => !allFields.some((f) => f.recipient_id === r.id));
  if (withoutField.length)
    return res.status(400).json({ error: `Every signer needs at least one field: ${withoutField.map((r) => r.name).join(', ')}` });

  const bytes = fs.readFileSync(d.file_path);
  const hash = sha256(bytes);
  db.prepare(`UPDATE documents SET status='sent', sent_at=?, sha256_sent=? WHERE id=?`).run(nowIso(), hash, d.id);
  db.prepare(`UPDATE recipients SET token_expires_at=? WHERE document_id=?`).run(newExpiry(), d.id);
  logEvent(d.id, { type: 'document.sent', detail: `sha256=${hash}`, req });

  const links = recips.map((r) => ({ name: r.name, email: r.email, url: signUrl(req, r) }));
  console.log(`\n[InkWell] Document "${d.title}" sent. Signing links:`);
  links.forEach((l) => console.log(`  ${l.name} <${l.email}>: ${l.url}`));
  await notifyPendingSigners(d, req);
  res.json({ ok: true, links, emailMode });
}));

// Bulk send: fan one draft PDF out to many recipients — one independent,
// individually-tracked document per person, laid out from a 1-signer template.
app.post('/api/documents/:id/bulk-send', asyncH(async (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (d.status !== 'draft') return res.status(409).json({ error: 'Bulk send starts from a draft document.' });

  const tpl = db.prepare('SELECT * FROM templates WHERE id=?').get(String(req.body?.templateId || ''));
  if (!tpl || tpl.owner_id !== req.user.id) return res.status(404).json({ error: 'Template not found.' });
  const tplFields = JSON.parse(tpl.fields);
  if (tplFields.some((f) => f.role !== 1)) {
    return res.status(400).json({ error: 'Bulk send needs a single-signer template (all fields for signer 1).' });
  }

  const list = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  if (!list.length) return res.status(400).json({ error: 'Add at least one recipient.' });
  if (list.length > 100) return res.status(400).json({ error: 'Bulk send is limited to 100 recipients at a time.' });
  const recipients = list.map((r) => ({ name: String(r?.name || '').trim(), email: String(r?.email || '').trim() }));
  const bad = recipients.find((r) => !r.name || !EMAIL_RE.test(r.email));
  if (bad) return res.status(400).json({ error: `Every recipient needs a name and a valid email (check “${bad.name || bad.email || 'blank line'}”).` });

  // The template's pages must exist in this document.
  const srcBytes = await fsp.readFile(d.file_path);
  const pageCount = (await PDFDocument.load(srcBytes)).getPageCount();
  const maxPage = Math.max(...tplFields.map((f) => f.page));
  if (maxPage > pageCount) {
    return res.status(400).json({ error: `The template places fields on page ${maxPage}, but this document has only ${pageCount} page(s).` });
  }

  const hash = sha256(srcBytes);
  const created = [];
  for (const r of recipients) {
    const docId = newId();
    const filePath = path.join(UPLOAD_DIR, `${docId}.pdf`);
    await fsp.copyFile(d.file_path, filePath);
    const rid = newId();
    const token = newToken();
    transaction(() => {
      db.prepare(
        `INSERT INTO documents (id, title, original_name, file_path, status, sha256_sent, created_at, sent_at, owner_id)
         VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?)`
      ).run(docId, `${d.title} — ${r.name}`, d.original_name, filePath, hash, nowIso(), nowIso(), req.user.id);
      db.prepare(
        `INSERT INTO recipients (id, document_id, name, email, signing_order, token, status, token_expires_at)
         VALUES (?, ?, ?, ?, 1, ?, 'pending', ?)`
      ).run(rid, docId, r.name, r.email, token, newExpiry());
      const insField = db.prepare(
        `INSERT INTO fields (id, document_id, recipient_id, page, type, x_ratio, y_ratio, w_ratio, h_ratio, required, options, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of tplFields) {
        insField.run(
          newId(), docId, rid, f.page, f.type,
          clamp(f.x_ratio), clamp(f.y_ratio), clamp(f.w_ratio), clamp(f.h_ratio),
          f.required === false ? 0 : 1, normalizeOptions(f.type, f.options), nowIso()
        );
      }
    });
    logEvent(docId, { type: 'document.created', detail: `bulk from “${d.title}” via template “${tpl.name}”`, req });
    logEvent(docId, { type: 'document.sent', detail: `sha256=${hash}`, req });
    const newDoc = q.doc.get(docId);
    await notifyPendingSigners(newDoc, req); // emails the invite, records signer.invited
    created.push({ name: r.name, email: r.email, documentId: docId, url: `${baseUrl(req)}/sign.html?t=${token}` });
  }
  logEvent(d.id, { type: 'document.bulk_sent', detail: `${created.length} document(s) via template “${tpl.name}”`, req });
  console.log(`\n[InkWell] Bulk send: "${d.title}" -> ${created.length} recipient(s).`);
  res.json({ ok: true, created, emailMode });
}));

app.post('/api/documents/:id/void', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  db.prepare(`UPDATE documents SET status='voided' WHERE id=?`).run(d.id);
  logEvent(d.id, { type: 'document.voided', req });
  res.json({ ok: true });
});

// Re-email the signer(s) whose turn it currently is.
app.post('/api/documents/:id/remind', asyncH(async (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (d.status !== 'sent') return res.status(409).json({ error: 'Only sent documents can be reminded.' });
  const pending = q.recips.all(d.id).filter((r) => r.status !== 'signed' && r.status !== 'declined' && !blockedByOrder(r));
  if (!pending.length) return res.status(400).json({ error: 'No one is currently awaiting signature.' });
  let sent = 0;
  for (let r of pending) {
    // Expired link? Mint a fresh token + expiry so the reminder actually works.
    if (linkExpired(r)) {
      const fresh = newToken();
      db.prepare(`UPDATE recipients SET token=?, token_expires_at=?, code_verified_at=NULL WHERE id=?`)
        .run(fresh, newExpiry(), r.id);
      logEvent(d.id, { recipientId: r.id, type: 'signer.link_regenerated', detail: r.email, req });
      r = { ...r, token: fresh };
    }
    try {
      await sendReminder({ recipient: r, document: d, url: signUrl(req, r) });
      logEvent(d.id, { recipientId: r.id, type: 'signer.reminded', detail: r.email, req });
      sent++;
    } catch (e) {
      console.error('reminder email failed for', r.email, e.message);
    }
  }
  res.json({ ok: true, reminded: pending.map((r) => r.name), emailMode });
}));

app.get('/api/documents/:id/audit', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  res.json({ document: d, recipients: q.recips.all(d.id).map(publicRecipient), events: getEvents(d.id), certInfo: getCertInfo() });
});

// Full audit record as a downloadable JSON file (compliance/legal handoff).
app.get('/api/documents/:id/audit.json', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  const payload = {
    exportedAt: nowIso(),
    document: d,
    signingCertificate: getCertInfo(),
    recipients: q.recips.all(d.id).map(publicRecipient),
    fields: q.fields.all(d.id).map(({ value, ...f }) => f), // omit raw signature images
    events: getEvents(d.id),
  };
  res.type('application/json')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(d.title)}-audit.json"`)
    .send(JSON.stringify(payload, null, 2));
});

// Event log as CSV.
app.get('/api/documents/:id/audit.csv', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  const rows = [['timestamp', 'event', 'detail', 'recipient_id', 'ip', 'user_agent']];
  for (const e of getEvents(d.id)) {
    rows.push([e.created_at, e.event_type, e.detail || '', e.recipient_id || '', e.ip || '', e.user_agent || '']);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.type('text/csv')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(d.title)}-audit.csv"`)
    .send(csv);
});

app.get('/api/documents/:id/final', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (!d.final_path) return res.status(404).json({ error: 'Not completed yet.' });
  res.type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(d.title)}-signed.pdf"`);
  res.sendFile(d.final_path);
});

// Download the RFC-3161 timestamp token (verifiable with `openssl ts -verify`).
app.get('/api/documents/:id/timestamp', (req, res) => {
  const d = ownedDoc(req, res);
  if (!d) return;
  if (!d.tsr_path) return res.status(404).json({ error: 'No trusted timestamp for this document.' });
  res.type('application/timestamp-reply')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(d.title)}.tsr"`);
  res.sendFile(d.tsr_path);
});

// ---- notifications -------------------------------------------------------

const signUrl = (req, r) => `${baseUrl(req)}/sign.html?t=${r.token}`;

// Email every signer whose turn it is (order-unblocked) and who hasn't been
// invited yet; records invited_at so nobody is emailed twice.
async function notifyPendingSigners(document, req) {
  const recips = q.recips.all(document.id);
  for (const r of recips) {
    if (r.status === 'signed' || r.invited_at || blockedByOrder(r)) continue;
    try {
      await sendInvitation({ recipient: r, document, url: signUrl(req, r) });
      db.prepare('UPDATE recipients SET invited_at=? WHERE id=?').run(nowIso(), r.id);
      logEvent(document.id, { recipientId: r.id, type: 'signer.invited', detail: r.email });
    } catch (e) {
      console.error('invite email failed for', r.email, e.message);
    }
  }
}

// When a document completes, notify all signers, the owner, and any CC
// addresses with a status link.
async function onCompleted(document, recips, req) {
  const owner = document.owner_id ? db.prepare('SELECT * FROM users WHERE id=?').get(document.owner_id) : null;
  const statusUrl = `${baseUrl(req)}/status.html?id=${document.id}`;
  // Signers get their own tokenized link (which now serves the sealed PDF);
  // the owner gets the status page; CC addresses get a plain notification.
  const targets = recips.map((r) => ({ name: r.name, email: r.email, url: signUrl(req, r) }));
  if (owner && !targets.some((t) => t.email.toLowerCase() === owner.email)) {
    targets.push({ name: owner.name || owner.email, email: owner.email, url: statusUrl });
  }
  let ccNotified = [];
  if (document.cc_list) {
    try {
      for (const c of JSON.parse(document.cc_list)) {
        if (targets.some((t) => t.email.toLowerCase() === c.email.toLowerCase())) continue;
        targets.push({ name: c.name || c.email, email: c.email, url: null });
        ccNotified.push(c.email);
      }
    } catch { /* malformed cc_list — skip */ }
  }
  if (ccNotified.length) {
    logEvent(document.id, { type: 'document.cc_notified', detail: ccNotified.join(', ') });
  }
  for (const t of targets) {
    try {
      await sendCompletion({ recipient: t, document, url: t.url });
    } catch (e) {
      console.error('completion email failed for', t.email, e.message);
    }
  }
}

// ---- signer flow (token based) ------------------------------------------

// Throttle all token-based signer endpoints per IP.
app.use('/api/sign', signLimiter);

function signerView(token) {
  const r = q.recipByToken.get(token);
  if (!r) return null;
  const d = q.doc.get(r.document_id);
  return { recipient: r, document: d };
}

// Enforce signing order: a recipient can sign only once everyone ahead is done.
function blockedByOrder(recipient) {
  const ahead = db
    .prepare(`SELECT * FROM recipients WHERE document_id=? AND signing_order < ? AND status != 'signed'`)
    .all(recipient.document_id, recipient.signing_order);
  return ahead.length > 0;
}

// A signer with an access code set must verify it before seeing the document.
const codeGated = (r) => !!r.access_code_hash && !r.code_verified_at;

app.get('/api/sign/:token', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid or expired signing link.' });
  const { recipient, document } = v;
  if (linkExpired(recipient)) {
    return res.json({ expired: true, document: { title: document.title } });
  }
  if (recipient.status === 'pending') {
    db.prepare(`UPDATE recipients SET status='viewed', viewed_at=? WHERE id=?`).run(nowIso(), recipient.id);
    logEvent(document.id, { recipientId: recipient.id, type: 'signer.viewed', detail: recipient.email, req });
  }
  if (codeGated(recipient)) {
    // Reveal nothing beyond what's needed to prompt for the code.
    return res.json({
      codeRequired: true,
      document: { title: document.title, status: document.status },
      recipient: { name: recipient.name },
    });
  }
  res.json({
    document: { id: document.id, title: document.title, status: document.status },
    recipient: {
      id: recipient.id, name: recipient.name, email: recipient.email,
      status: q.recipByToken.get(req.params.token).status,
      consented: !!recipient.consent_at,
    },
    fields: q.fieldsForRecip.all(recipient.id),
    waitingForOthers: blockedByOrder(recipient),
    alreadyComplete: document.status === 'completed' || recipient.status === 'signed',
    declined: recipient.status === 'declined' || document.status === 'voided',
  });
});

// Verify a signer's access code. Tightly throttled: 10 tries per 10 minutes
// per IP+token on top of the general signer limiter.
const codeLimiter = rateLimit({ max: 10, windowMs: 10 * 60_000, message: 'Too many code attempts. Please wait a few minutes.' });
app.post('/api/sign/:token/verify-code', codeLimiter, (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid link.' });
  const { recipient, document } = v;
  if (linkExpired(recipient)) return res.status(410).json({ error: 'This signing link has expired.' });
  if (!recipient.access_code_hash) return res.json({ ok: true }); // nothing to verify
  const code = String(req.body?.code || '');
  if (!code || !verifyPassword(code, recipient.access_code_hash)) {
    logEvent(document.id, { recipientId: recipient.id, type: 'signer.code_failed', detail: recipient.email, req });
    return res.status(401).json({ error: 'That access code is incorrect.' });
  }
  db.prepare('UPDATE recipients SET code_verified_at=? WHERE id=?').run(nowIso(), recipient.id);
  logEvent(document.id, {
    recipientId: recipient.id,
    type: 'signer.code_verified',
    detail: `${recipient.name} verified the access code`,
    req,
  });
  res.json({ ok: true });
});

app.get('/api/sign/:token/file', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).end();
  if (linkExpired(v.recipient)) return res.status(410).end();
  if (codeGated(v.recipient)) return res.status(403).end();
  res.type('application/pdf').sendFile(v.document.file_path);
});

// ESIGN retention: every signer can download the completed, sealed PDF from
// their own link once all parties have signed.
app.get('/api/sign/:token/final', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).end();
  const { recipient, document } = v;
  if (codeGated(recipient)) return res.status(403).end();
  if (document.status !== 'completed' || !document.final_path) {
    return res.status(404).json({ error: 'Not completed yet.' });
  }
  logEvent(document.id, { recipientId: recipient.id, type: 'signer.downloaded_final', detail: recipient.email, req });
  res.type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(document.title)}-signed.pdf"`);
  res.sendFile(document.final_path);
});

app.post('/api/sign/:token/consent', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid link.' });
  const { recipient, document } = v;
  if (linkExpired(recipient)) return res.status(410).json({ error: 'This signing link has expired.' });
  if (codeGated(recipient)) return res.status(403).json({ error: 'Access code required.' });
  db.prepare(`UPDATE recipients SET consent_at=?, ip=?, user_agent=? WHERE id=?`).run(
    nowIso(), clientIp(req), req.get('user-agent') || null, recipient.id
  );
  logEvent(document.id, {
    recipientId: recipient.id,
    type: 'signer.consented',
    detail: 'Agreed to use electronic records and signatures (ESIGN/UETA).',
    req,
  });
  res.json({ ok: true });
});

// Decline to sign: records the reason, voids the document, notifies everyone.
app.post('/api/sign/:token/decline', asyncH(async (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid link.' });
  const { recipient, document } = v;
  if (linkExpired(recipient)) return res.status(410).json({ error: 'This signing link has expired.' });
  if (codeGated(recipient)) return res.status(403).json({ error: 'Access code required.' });
  if (recipient.status === 'signed') return res.status(409).json({ error: 'You have already signed.' });
  if (document.status === 'completed') return res.status(409).json({ error: 'This document is already complete.' });
  const reason = String(req.body?.reason || '').slice(0, 500).trim();

  db.prepare(`UPDATE recipients SET status='declined', decline_reason=?, ip=?, user_agent=? WHERE id=?`).run(
    reason || null, clientIp(req), req.get('user-agent') || null, recipient.id
  );
  db.prepare(`UPDATE documents SET status='voided' WHERE id=?`).run(document.id);
  logEvent(document.id, {
    recipientId: recipient.id,
    type: 'signer.declined',
    detail: reason ? `${recipient.name}: ${reason}` : `${recipient.name} declined`,
    req,
  });

  // Notify the owner and the other signers that it was declined + voided.
  const statusUrl = `${baseUrl(req)}/status.html?id=${document.id}`;
  const owner = document.owner_id ? db.prepare('SELECT * FROM users WHERE id=?').get(document.owner_id) : null;
  const targets = q.recips.all(document.id)
    .filter((r) => r.id !== recipient.id)
    .map((r) => ({ name: r.name, email: r.email, url: statusUrl }));
  if (owner) targets.push({ name: owner.name || owner.email, email: owner.email, url: statusUrl });
  for (const t of targets) {
    try {
      await sendDeclined({ to: t.email, name: t.name, document, declinedBy: recipient.name, reason, url: t.url });
    } catch (e) {
      console.error('decline email failed for', t.email, e.message);
    }
  }
  res.json({ ok: true });
}));

app.post(
  '/api/sign/:token/complete',
  asyncH(async (req, res) => {
    const v = signerView(req.params.token);
    if (!v) return res.status(404).json({ error: 'Invalid link.' });
    const { recipient, document } = v;
    if (linkExpired(recipient)) return res.status(410).json({ error: 'This signing link has expired.' });
    if (codeGated(recipient)) return res.status(403).json({ error: 'Access code required.' });
    if (document.status !== 'sent') return res.status(409).json({ error: 'This document is not open for signing.' });
    if (recipient.status === 'signed') return res.status(409).json({ error: 'You have already signed.' });
    if (!recipient.consent_at) return res.status(400).json({ error: 'Consent is required before signing.' });
    if (blockedByOrder(recipient)) return res.status(409).json({ error: 'It is not your turn to sign yet.' });

    const values = req.body.values || {}; // { fieldId: value }
    const myFields = q.fieldsForRecip.all(recipient.id);
    for (const f of myFields) {
      const val = values[f.id];
      if (f.required && (val == null || val === '')) {
        return res.status(400).json({ error: 'Please complete all required fields.' });
      }
      // For option-based fields, a provided value must be one of the choices.
      if ((f.type === 'dropdown' || f.type === 'radio') && val != null && val !== '') {
        if (!parseOptions(f.options).includes(String(val))) {
          return res.status(400).json({ error: 'Invalid selection for one of the fields.' });
        }
      }
    }
    const setVal = db.prepare('UPDATE fields SET value=? WHERE id=?');
    transaction(() => {
      for (const f of myFields) if (values[f.id] != null) setVal.run(String(values[f.id]), f.id);
      db.prepare(`UPDATE recipients SET status='signed', signed_at=?, ip=?, user_agent=? WHERE id=?`).run(
        nowIso(), clientIp(req), req.get('user-agent') || null, recipient.id
      );
    });
    logEvent(document.id, {
      recipientId: recipient.id,
      type: 'signer.signed',
      detail: `${recipient.name} applied signature with intent to sign`,
      req,
    });

    // If everyone has signed, produce the final document and cryptographically seal it.
    const recips = q.recips.all(document.id);
    if (recips.every((r) => r.status === 'signed')) {
      const fields = q.fields.all(document.id);
      const certInfo = getCertInfo();
      const { bytes } = await buildFinalPdf({ document, recipients: recips, fields, certInfo });
      const sealed = await sealPdf(bytes, { reason: `Completed via InkWell — ${document.title}` });
      const finalHash = sha256(sealed);
      const finalPath = path.join(UPLOAD_DIR, `${document.id}-final.pdf`);
      await fsp.writeFile(finalPath, sealed);
      db.prepare(`UPDATE documents SET status='completed', completed_at=?, sha256_final=?, final_path=? WHERE id=?`).run(
        nowIso(), finalHash, finalPath, document.id
      );
      logEvent(document.id, {
        type: 'document.sealed',
        detail: `PKCS#7 seal · cert ${certInfo.fingerprintSha256}`,
        req,
      });

      // Best-effort RFC-3161 trusted timestamp over the sealed bytes.
      const ts = await timestamp(sealed);
      if (ts) {
        const tsrPath = path.join(UPLOAD_DIR, `${document.id}.tsr`);
        await fsp.writeFile(tsrPath, ts.tokenDer);
        db.prepare(`UPDATE documents SET tsa_time=?, tsa_url=?, tsr_path=? WHERE id=?`).run(
          ts.genTime, ts.tsaUrl, tsrPath, document.id
        );
        logEvent(document.id, {
          type: 'document.timestamped',
          detail: `RFC-3161 trusted time ${ts.genTime} via ${ts.tsaUrl}`,
          req,
        });
      } else {
        logEvent(document.id, {
          type: 'document.timestamp_skipped',
          detail: 'TSA unreachable — sealed with server clock only',
          req,
        });
      }
      logEvent(document.id, { type: 'document.completed', detail: `final sha256=${finalHash}`, req });
      const completedDoc = q.doc.get(document.id);
      onCompleted(completedDoc, recips, req).catch((e) => console.error('completion notify failed', e));
    } else {
      // Not done yet — invite whoever is now unblocked (next in signing order).
      await notifyPendingSigners(document, req);
    }
    res.json({ ok: true });
  })
);

// ---- misc ---------------------------------------------------------------

function clamp(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
// Option-based fields (dropdown | radio) store a JSON array of trimmed,
// de-duplicated, non-empty choices. Other field types store null.
function normalizeOptions(type, options) {
  if (type !== 'dropdown' && type !== 'radio') return null;
  const list = Array.isArray(options) ? options : [];
  const clean = [...new Set(list.map((o) => String(o).trim()).filter(Boolean))].slice(0, 30);
  return clean.length ? JSON.stringify(clean) : JSON.stringify([]);
}
// Parse a stored options column back to an array (empty on any problem).
function parseOptions(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
function safeName(s) {
  return String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'document';
}
// Quote a CSV cell if it contains a comma, quote, or newline (RFC 4180).
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InkWell e-sign running at http://localhost:${PORT}`));
