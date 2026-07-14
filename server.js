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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

function docPayload(id) {
  const document = q.doc.get(id);
  if (!document) return null;
  return {
    document,
    recipients: q.recips.all(id),
    fields: q.fields.all(id),
  };
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
      `INSERT INTO documents (id, title, original_name, file_path, status, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?)`
    ).run(id, title, req.file.originalname, req.file.path, nowIso());
    logEvent(id, { type: 'document.created', detail: `${title} (${pageCount} pages)`, req });
    res.json({ id, pageCount });
  })
);

app.get('/api/documents', (_req, res) => {
  const rows = q.docs.all().map((d) => {
    const recips = q.recips.all(d.id);
    return {
      ...d,
      signers: recips.length,
      signed: recips.filter((r) => r.status === 'signed').length,
    };
  });
  res.json(rows);
});

app.get('/api/documents/:id', (req, res) => {
  const payload = docPayload(req.params.id);
  if (!payload) return res.status(404).json({ error: 'Not found' });
  res.json(payload);
});

// Serve the original PDF bytes (authoring / preview).
app.get('/api/documents/:id/file', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).end();
  res.type('application/pdf').sendFile(d.file_path);
});

// Save recipients + field placements. Only allowed while in draft.
app.put('/api/documents/:id/prepare', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.status !== 'draft') return res.status(409).json({ error: 'Document already sent.' });

  const { recipients = [], fields = [] } = req.body;
  if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient.' });

  transaction(() => {
    db.prepare('DELETE FROM fields WHERE document_id = ?').run(d.id);
    db.prepare('DELETE FROM recipients WHERE document_id = ?').run(d.id);

    // Map the client's temporary recipient keys to real ids.
    const idFor = {};
    const insRecip = db.prepare(
      `INSERT INTO recipients (id, document_id, name, email, signing_order, token, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    );
    recipients.forEach((r, i) => {
      const rid = newId();
      idFor[r.key ?? r.id ?? i] = rid;
      insRecip.run(rid, d.id, (r.name || '').trim(), (r.email || '').trim(), Number(r.signing_order) || i + 1, newToken());
    });

    const insField = db.prepare(
      `INSERT INTO fields (id, document_id, recipient_id, page, type, x_ratio, y_ratio, w_ratio, h_ratio, required, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fields) {
      const rid = idFor[f.recipientKey];
      if (!rid) continue;
      insField.run(
        newId(), d.id, rid, Number(f.page), f.type,
        clamp(f.x_ratio), clamp(f.y_ratio), clamp(f.w_ratio), clamp(f.h_ratio),
        f.required === false ? 0 : 1, nowIso()
      );
    }
  });
  logEvent(d.id, { type: 'document.prepared', detail: `${recipients.length} recipient(s), ${fields.length} field(s)`, req });
  res.json(docPayload(d.id));
});

// Send for signature: lock the document, hash it, mint links.
app.post('/api/documents/:id/send', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
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
  logEvent(d.id, { type: 'document.sent', detail: `sha256=${hash}`, req });

  const base = `${req.protocol}://${req.get('host')}`;
  const links = recips.map((r) => ({ name: r.name, email: r.email, url: `${base}/sign.html?t=${r.token}` }));
  console.log(`\n[InkWell] Document "${d.title}" sent. Signing links:`);
  links.forEach((l) => console.log(`  ${l.name} <${l.email}>: ${l.url}`));
  res.json({ ok: true, links });
});

app.post('/api/documents/:id/void', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE documents SET status='voided' WHERE id=?`).run(d.id);
  logEvent(d.id, { type: 'document.voided', req });
  res.json({ ok: true });
});

app.get('/api/documents/:id/audit', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ document: d, recipients: q.recips.all(d.id), events: getEvents(d.id) });
});

app.get('/api/documents/:id/final', (req, res) => {
  const d = q.doc.get(req.params.id);
  if (!d || !d.final_path) return res.status(404).json({ error: 'Not completed yet.' });
  res.type('application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${safeName(d.title)}-signed.pdf"`);
  res.sendFile(d.final_path);
});

// ---- signer flow (token based) ------------------------------------------

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

app.get('/api/sign/:token', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid or expired signing link.' });
  const { recipient, document } = v;
  if (recipient.status === 'pending') {
    db.prepare(`UPDATE recipients SET status='viewed', viewed_at=? WHERE id=?`).run(nowIso(), recipient.id);
    logEvent(document.id, { recipientId: recipient.id, type: 'signer.viewed', detail: recipient.email, req });
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
  });
});

app.get('/api/sign/:token/file', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).end();
  res.type('application/pdf').sendFile(v.document.file_path);
});

app.post('/api/sign/:token/consent', (req, res) => {
  const v = signerView(req.params.token);
  if (!v) return res.status(404).json({ error: 'Invalid link.' });
  const { recipient, document } = v;
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

app.post(
  '/api/sign/:token/complete',
  asyncH(async (req, res) => {
    const v = signerView(req.params.token);
    if (!v) return res.status(404).json({ error: 'Invalid link.' });
    const { recipient, document } = v;
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

    // If everyone has signed, produce the final document.
    const recips = q.recips.all(document.id);
    if (recips.every((r) => r.status === 'signed')) {
      const fields = q.fields.all(document.id);
      const { bytes, sha256: finalHash } = await buildFinalPdf({ document, recipients: recips, fields });
      const finalPath = path.join(UPLOAD_DIR, `${document.id}-final.pdf`);
      await fsp.writeFile(finalPath, bytes);
      db.prepare(`UPDATE documents SET status='completed', completed_at=?, sha256_final=?, final_path=? WHERE id=?`).run(
        nowIso(), finalHash, finalPath, document.id
      );
      logEvent(document.id, { type: 'document.completed', detail: `final sha256=${finalHash}`, req });
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
function safeName(s) {
  return String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'document';
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InkWell e-sign running at http://localhost:${PORT}`));
