// InkWell end-to-end regression suite.
//
//   npm test
//
// Boots a private server instance against a scratch data/uploads directory
// (nothing in ./data or ./uploads is touched), walks every feature end to
// end, and exits non-zero on the first failure. No network access is needed:
// email runs in log-only mode and the TSA URL points at a dead local port so
// timestamping records a skip, exactly as it would offline.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-test-'));
const DATA_DIR = path.join(SCRATCH, 'data');
const UPLOAD_DIR = path.join(SCRATCH, 'uploads');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error(`\nFAIL: ${msg}`); shutdown(1); }
  passed++;
  console.log(`ok ${String(passed).padStart(3)} - ${msg}`);
};
const section = (name) => console.log(`\n# ${name}`);

// ---- boot ----------------------------------------------------------------

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    INKWELL_DATA_DIR: DATA_DIR,
    INKWELL_UPLOAD_DIR: UPLOAD_DIR,
    AUTH_RATE_MAX: '100000',
    SIGN_RATE_MAX: '100000',
    TSA_URL: 'http://127.0.0.1:9/tsr', // unroutable -> timestamp gracefully skipped
    SMTP_HOST: '',                      // force log-only email
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d; });

function shutdown(code) {
  try { child.kill(); } catch { /* already dead */ }
  setTimeout(() => {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* WAL handles */ }
    if (code) console.error(stderrBuf.slice(-2000));
    process.exit(code);
  }, 400);
}

for (let i = 0; ; i++) {
  try { await fetch(`${BASE}/api/auth/me`); break; }
  catch { if (i > 50) { console.error('server never came up\n' + stderrBuf); process.exit(1); } await new Promise((r) => setTimeout(r, 200)); }
}

// ---- helpers -------------------------------------------------------------

const jars = {}; // name -> cookie
let jar = 'a';
const asUser = (name) => { jar = name; };
async function api(p, { method = 'GET', json, form } = {}) {
  const headers = { cookie: jars[jar] || '' };
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = form; }
  const res = await fetch(BASE + p, { method, headers, body });
  const sc = res.headers.get('set-cookie');
  if (sc) jars[jar] = sc.split(';')[0];
  return res;
}
async function makePdf(pages = 1) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]);
  return pdf.save();
}
async function upload(title, pages = 1) {
  const form = new FormData();
  form.append('title', title);
  form.append('pdf', new Blob([await makePdf(pages)], { type: 'application/pdf' }), `${title}.pdf`);
  const res = await api('/api/documents', { method: 'POST', form });
  return res.json();
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAoGH9pYAAAAASUVORK5CYII=';
const sigField = (key, x = 0.1) => ({ recipientKey: key, page: 1, type: 'signature', x_ratio: x, y_ratio: 0.7, w_ratio: 0.3, h_ratio: 0.08 });
const tokenOf = (url) => new URL(url).searchParams.get('t');
async function signThrough(tok, extra = {}) {
  let res = await api(`/api/sign/${tok}`);
  const view = await res.json();
  await api(`/api/sign/${tok}/consent`, { method: 'POST' });
  const values = {};
  for (const f of view.fields) values[f.id] = extra[f.type] ?? (f.type === 'signature' || f.type === 'initials' ? PNG : 'x');
  return api(`/api/sign/${tok}/complete`, { method: 'POST', json: { values } });
}

// ---- auth ----------------------------------------------------------------

section('auth');
let res = await api('/api/auth/register', { method: 'POST', json: { email: 'owner@test.local', name: 'Owner', password: 'password123' } });
assert(res.ok, 'register');
res = await api('/api/auth/register', { method: 'POST', json: { email: 'owner@test.local', name: 'Dup', password: 'password123' } });
assert(res.status === 409, 'duplicate email rejected');
res = await api('/api/auth/register', { method: 'POST', json: { email: 'short@test.local', name: 'S', password: 'short' } });
assert(res.status === 400, 'short password rejected');
res = await api('/api/documents');
assert(res.ok, 'authed list works');
asUser('anon');
res = await api('/api/documents');
assert(res.status === 401, 'unauthenticated list blocked');
asUser('a');

// ---- upload + prepare validation ----------------------------------------

section('upload + prepare');
res = await api('/api/documents', { method: 'POST', form: (() => { const f = new FormData(); f.append('title', 'x'); f.append('pdf', new Blob([Buffer.from('not a pdf')], { type: 'application/pdf' }), 'x.pdf'); return f; })() });
assert(res.status === 400, 'non-PDF rejected');
const doc1 = await upload('Main Flow');
assert(doc1.id && doc1.pageCount === 1, 'PDF uploaded');
res = await api(`/api/documents/${doc1.id}/prepare`, { method: 'PUT', json: { recipients: [], fields: [] } });
assert(res.status === 400, 'prepare without recipients rejected');
res = await api(`/api/documents/${doc1.id}/prepare`, { method: 'PUT', json: {
  recipients: [
    { key: 1, name: 'Ada', email: 'ada@test.local', signing_order: 1 },
    { key: 2, name: 'Bob', email: 'bob@test.local', signing_order: 2 },
  ],
  fields: [
    sigField(1), sigField(2, 0.55),
    { recipientKey: 1, page: 1, type: 'checkbox', x_ratio: 0.1, y_ratio: 0.4, w_ratio: 0.04, h_ratio: 0.03, required: true },
    { recipientKey: 1, page: 1, type: 'dropdown', x_ratio: 0.1, y_ratio: 0.2, w_ratio: 0.3, h_ratio: 0.04, required: true, options: ['Gold', 'Silver', 'Gold', ' '] },
  ],
  cc: [{ name: 'Archive', email: 'archive@test.local' }],
} });
assert(res.ok, 'prepare with mixed fields + cc');
let payload = await res.json();
const ddOpts = JSON.parse(payload.fields.find((f) => f.type === 'dropdown').options);
assert(ddOpts.length === 2, 'dropdown options de-duped/trimmed');
assert(JSON.parse(payload.document.cc_list).length === 1, 'cc stored');

// ---- send + signing order + field validation -----------------------------

section('send + sign');
res = await api(`/api/documents/${doc1.id}/send`, { method: 'POST' });
assert(res.ok, 'send');
const links1 = (await res.json()).links;
const adaTok = tokenOf(links1.find((l) => l.name === 'Ada').url);
const bobTok = tokenOf(links1.find((l) => l.name === 'Bob').url);
res = await api(`/api/sign/${bobTok}`);
assert((await res.json()).waitingForOthers === true, 'signing order blocks Bob');
res = await api(`/api/sign/${adaTok}`);
let view = await res.json();
res = await api(`/api/sign/${adaTok}/complete`, { method: 'POST', json: { values: {} } });
assert(res.status === 400, 'complete before consent rejected');
await api(`/api/sign/${adaTok}/consent`, { method: 'POST' });
const adaVals = {};
for (const f of view.fields) adaVals[f.id] = f.type === 'signature' ? PNG : f.type === 'checkbox' ? '' : 'Gold';
res = await api(`/api/sign/${adaTok}/complete`, { method: 'POST', json: { values: adaVals } });
assert(res.status === 400, 'unchecked required checkbox rejected');
for (const f of view.fields) if (f.type === 'dropdown') adaVals[f.id] = 'Platinum';
for (const f of view.fields) if (f.type === 'checkbox') adaVals[f.id] = 'true';
res = await api(`/api/sign/${adaTok}/complete`, { method: 'POST', json: { values: adaVals } });
assert(res.status === 400, 'off-list dropdown value rejected');
for (const f of view.fields) if (f.type === 'dropdown') adaVals[f.id] = 'Gold';
res = await api(`/api/sign/${adaTok}/complete`, { method: 'POST', json: { values: adaVals } });
assert(res.ok, 'Ada signs');
res = await signThrough(bobTok);
assert(res.ok, 'Bob signs after order unblocks');

// ---- completion: seal, skip-timestamp, retention, cc ---------------------

section('completion');
res = await api(`/api/documents/${doc1.id}`);
const d1 = (await res.json()).document;
assert(d1.status === 'completed' && d1.sha256_final, 'completed with final hash');
res = await api(`/api/documents/${doc1.id}/final`);
let buf = Buffer.from(await res.arrayBuffer());
assert(buf.slice(0, 5).toString() === '%PDF-', 'owner downloads final PDF');
assert(buf.includes('/ByteRange'), 'final PDF carries a digital signature');
res = await api(`/api/documents/${doc1.id}/audit`);
let events = (await res.json()).events.map((e) => e.event_type);
assert(events.includes('document.sealed'), 'sealed event');
assert(events.includes('document.timestamp_skipped'), 'TSA unreachable -> skip recorded');
assert(events.includes('document.cc_notified'), 'cc notified');
res = await api(`/api/sign/${adaTok}/final`);
buf = Buffer.from(await res.arrayBuffer());
assert(res.ok && buf.slice(0, 5).toString() === '%PDF-', 'signer downloads sealed copy');
res = await api(`/api/documents/${doc1.id}/audit.json`);
const exp = await res.json();
assert(exp.recipients.every((r) => r.access_code_hash === undefined), 'audit.json hides code hashes');
assert(exp.fields.every((f) => f.value === undefined), 'audit.json omits field values');
res = await api(`/api/documents/${doc1.id}/audit.csv`);
assert(res.ok && (await res.text()).startsWith('timestamp,'), 'audit.csv exports');

// ---- decline -------------------------------------------------------------

section('decline');
const doc2 = await upload('Decline Flow');
await api(`/api/documents/${doc2.id}/prepare`, { method: 'PUT', json: {
  recipients: [{ key: 1, name: 'Neil', email: 'neil@test.local', signing_order: 1 }],
  fields: [sigField(1)],
} });
res = await api(`/api/documents/${doc2.id}/send`, { method: 'POST' });
const neilTok = tokenOf((await res.json()).links[0].url);
res = await api(`/api/sign/${neilTok}/decline`, { method: 'POST', json: { reason: 'Wrong terms' } });
assert(res.ok, 'decline accepted');
res = await api(`/api/documents/${doc2.id}`);
assert((await res.json()).document.status === 'voided', 'declined doc voided');
res = await api(`/api/sign/${neilTok}`);
assert((await res.json()).declined === true, 'signer view shows voided');

// ---- access codes --------------------------------------------------------

section('access codes');
const doc3 = await upload('Code Flow');
await api(`/api/documents/${doc3.id}/prepare`, { method: 'PUT', json: {
  recipients: [{ key: 1, name: 'Eve', email: 'eve@test.local', signing_order: 1, access_code: 'tulip-77' }],
  fields: [sigField(1)],
} });
res = await api(`/api/documents/${doc3.id}/send`, { method: 'POST' });
const eveTok = tokenOf((await res.json()).links[0].url);
res = await api(`/api/sign/${eveTok}`);
assert((await res.json()).codeRequired === true, 'code gate engages');
res = await api(`/api/sign/${eveTok}/file`);
assert(res.status === 403, 'file blocked while gated');
res = await api(`/api/sign/${eveTok}/verify-code`, { method: 'POST', json: { code: 'nope' } });
assert(res.status === 401, 'wrong code rejected');
res = await api(`/api/sign/${eveTok}/verify-code`, { method: 'POST', json: { code: 'tulip-77' } });
assert(res.ok, 'right code unlocks');
res = await signThrough(eveTok);
assert(res.ok, 'code-protected signer completes');

// ---- link expiry ---------------------------------------------------------

section('link expiry');
const doc4 = await upload('Expiry Flow');
await api(`/api/documents/${doc4.id}/prepare`, { method: 'PUT', json: {
  recipients: [{ key: 1, name: 'Tim', email: 'tim@test.local', signing_order: 1 }],
  fields: [sigField(1)],
} });
res = await api(`/api/documents/${doc4.id}/send`, { method: 'POST' });
const timTok = tokenOf((await res.json()).links[0].url);
{
  const sdb = new DatabaseSync(path.join(DATA_DIR, 'inkwell.db'));
  sdb.prepare('UPDATE recipients SET token_expires_at=? WHERE token=?')
    .run(new Date(Date.now() - 864e5).toISOString(), timTok);
  sdb.close();
}
res = await api(`/api/sign/${timTok}`);
assert((await res.json()).expired === true, 'expired link flagged');
res = await api(`/api/sign/${timTok}/consent`, { method: 'POST' });
assert(res.status === 410, 'expired consent 410');
res = await api(`/api/documents/${doc4.id}/remind`, { method: 'POST' });
assert(res.ok, 'reminder regenerates');
res = await api(`/api/documents/${doc4.id}`);
const tim = (await res.json()).recipients[0];
assert(tim.token !== timTok && !tim.link_expired, 'fresh token minted');
res = await signThrough(tim.token);
assert(res.ok, 'fresh link signs');

// ---- templates -----------------------------------------------------------

section('templates');
res = await api('/api/templates', { method: 'POST', json: { name: 'Suite Layout', fields: [
  { role: 1, page: 1, type: 'signature', x_ratio: 0.1, y_ratio: 0.7, w_ratio: 0.3, h_ratio: 0.08 },
  { role: 1, page: 1, type: 'date', x_ratio: 0.55, y_ratio: 0.7, w_ratio: 0.2, h_ratio: 0.04 },
] } });
assert(res.ok, 'template saved');
const tpl = (await res.json()).template;
asUser('b');
await api('/api/auth/register', { method: 'POST', json: { email: 'rival@test.local', name: 'Rival', password: 'password123' } });
res = await api('/api/templates');
assert((await res.json()).templates.length === 0, 'templates owner-scoped');
res = await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
assert(res.status === 404, "cannot delete someone else's template");
asUser('a');

// ---- bulk send -----------------------------------------------------------

section('bulk send');
const doc5 = await upload('Bulk Master');
res = await api(`/api/documents/${doc5.id}/bulk-send`, { method: 'POST', json: {
  templateId: tpl.id,
  recipients: [
    { name: 'P One', email: 'p1@test.local' },
    { name: 'P Two', email: 'p2@test.local' },
  ],
} });
assert(res.ok, 'bulk send');
const created = (await res.json()).created;
assert(created.length === 2, 'two docs created');
res = await api(`/api/documents/${doc5.id}`);
assert((await res.json()).document.status === 'draft', 'master stays draft');
res = await signThrough(tokenOf(created[0].url));
assert(res.ok, 'bulk recipient signs independently');
res = await api(`/api/documents/${created[0].documentId}`);
assert((await res.json()).document.status === 'completed', 'their copy completes alone');
res = await api(`/api/documents/${created[1].documentId}`);
assert((await res.json()).document.status === 'sent', 'other copy still open');

// ---- search / filter / archive / delete ----------------------------------

section('dashboard');
res = await api('/api/documents?q=bulk+master');
assert((await res.json()).some((d) => d.id === doc5.id), 'search by title');
res = await api('/api/documents?status=voided');
assert((await res.json()).every((d) => d.status === 'voided'), 'status filter');
res = await api(`/api/documents/${doc2.id}/archive`, { method: 'POST' });
assert(res.ok, 'archive');
res = await api('/api/documents');
assert(!(await res.json()).some((d) => d.id === doc2.id), 'archived hidden');
res = await api('/api/documents?archived=1');
assert((await res.json()).some((d) => d.id === doc2.id), 'archived view');
res = await api(`/api/documents/${doc2.id}/unarchive`, { method: 'POST' });
assert(res.ok, 'unarchive');
res = await api(`/api/documents/${doc1.id}`, { method: 'DELETE' });
assert(res.status === 409, 'completed doc cannot be deleted');
const doc6 = await upload('Doomed');
res = await api(`/api/documents/${doc6.id}`, { method: 'DELETE' });
assert(res.ok, 'draft deleted');
res = await api(`/api/documents/${doc6.id}`);
assert(res.status === 404, 'deleted draft gone');

// ---- ownership isolation -------------------------------------------------

section('ownership');
asUser('b');
res = await api(`/api/documents/${doc1.id}`);
assert(res.status === 403 || res.status === 404, "rival cannot read owner's doc");
res = await api(`/api/documents/${doc1.id}/final`);
assert(res.status === 403 || res.status === 404, "rival cannot download owner's final");
asUser('a');

// ---- settings ------------------------------------------------------------

section('settings');
res = await api('/api/auth/profile', { method: 'PUT', json: { name: 'Owner Renamed' } });
assert(res.ok, 'profile rename');
res = await api('/api/auth/password', { method: 'PUT', json: { current: 'wrong', next: 'password456' } });
assert(res.status === 401, 'password change needs current password');
res = await api('/api/auth/password', { method: 'PUT', json: { current: 'password123', next: 'password456' } });
assert(res.ok, 'password changed');
res = await api('/api/auth/login', { method: 'POST', json: { email: 'owner@test.local', password: 'password456' } });
assert(res.ok, 'new password logs in');

// ---- email verification --------------------------------------------------

section('email verification');
res = await api('/api/auth/me');
assert((await res.json()).user.verified === false, 'new account starts unverified');
{
  const crypto = await import('node:crypto');
  const verifyTok = 'test-verify-token-abc';
  const sdb = new DatabaseSync(path.join(DATA_DIR, 'inkwell.db'));
  const u = sdb.prepare(`SELECT * FROM users WHERE email='owner@test.local'`).get();
  assert(u.verify_token_hash && u.verify_token_hash.length === 64, 'verify token stored hashed');
  sdb.prepare('UPDATE users SET verify_token_hash=? WHERE id=?')
    .run(crypto.createHash('sha256').update(verifyTok).digest('hex'), u.id);
  sdb.close();
  res = await fetch(`${BASE}/api/auth/verify?t=wrong`, { redirect: 'manual' });
  assert(res.status === 400, 'bad verify token rejected');
  res = await fetch(`${BASE}/api/auth/verify?t=${verifyTok}`, { redirect: 'manual' });
  assert(res.status === 302, 'verify link redirects home');
  res = await fetch(`${BASE}/api/auth/verify?t=${verifyTok}`, { redirect: 'manual' });
  assert(res.status === 400, 'verify token single-use');
}
res = await api('/api/auth/me');
assert((await res.json()).user.verified === true, 'account now verified');
res = await api('/api/auth/resend-verification', { method: 'POST' });
assert((await res.json()).alreadyVerified === true, 'resend after verify is a no-op');

// ---- password reset ------------------------------------------------------

section('password reset');
res = await api('/api/auth/forgot', { method: 'POST', json: { email: 'nobody@test.local' } });
assert(res.ok, 'unknown email still answers 200 (no enumeration)');
res = await api('/api/auth/forgot', { method: 'POST', json: { email: 'owner@test.local' } });
assert(res.ok, 'reset requested');
// email is log-only, so pull the token via its hash from the scratch DB and
// mint a request the way the emailed link would.
let resetToken;
{
  const sdb = new DatabaseSync(path.join(DATA_DIR, 'inkwell.db'));
  const row = sdb.prepare(`SELECT pr.* FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE u.email='owner@test.local'`).get();
  assert(row && !row.used_at, 'reset row created unused');
  assert(row.token_hash.length === 64, 'token stored as sha256, not plaintext');
  // We can't invert the hash — so instead verify the API contract directly:
  // a made-up token fails, then simulate the real one by planting a known hash.
  const crypto = await import('node:crypto');
  resetToken = 'test-reset-token-123456';
  sdb.prepare('UPDATE password_resets SET token_hash=? WHERE id=?')
    .run(crypto.createHash('sha256').update(resetToken).digest('hex'), row.id);
  sdb.close();
}
res = await api('/api/auth/reset', { method: 'POST', json: { token: 'wrong-token', password: 'brandnewpass1' } });
assert(res.status === 400, 'bad token rejected');
res = await api('/api/auth/reset', { method: 'POST', json: { token: resetToken, password: 'short' } });
assert(res.status === 400, 'short password rejected');
res = await api('/api/auth/reset', { method: 'POST', json: { token: resetToken, password: 'brandnewpass1' } });
assert(res.ok, 'reset succeeds');
res = await api('/api/auth/reset', { method: 'POST', json: { token: resetToken, password: 'anotherpass1' } });
assert(res.status === 400, 'token single-use');
res = await api('/api/auth/me');
assert((await res.json()).user === null, 'all sessions revoked by reset');
res = await api('/api/auth/login', { method: 'POST', json: { email: 'owner@test.local', password: 'brandnewpass1' } });
assert(res.ok, 'reset password logs in');

// ---- rate limiter (unit) -------------------------------------------------

section('rate limiter');
{
  const { rateLimit } = await import(path.join(ROOT, 'lib', 'ratelimit.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const mw = rateLimit({ max: 3, windowMs: 60_000 });
  const fake = () => {
    let status = 200;
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' }, baseUrl: '/x', path: '/y', ip: '1.2.3.4' };
    const res = { setHeader() {}, status(s) { status = s; return this; }, json() { return this; } };
    let called = false;
    mw(req, res, () => { called = true; });
    return called ? 200 : status;
  };
  assert(fake() === 200 && fake() === 200 && fake() === 200, 'limiter allows under max');
  assert(fake() === 429, 'limiter blocks over max');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
shutdown(0);
