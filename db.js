// SQLite storage using Node's built-in node:sqlite (Node 22.5+/24).
// One file, synchronous API, no native build step required.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, 'data', 'inkwell.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | completed | voided
  sha256_sent   TEXT,
  sha256_final  TEXT,
  final_path    TEXT,
  created_at    TEXT NOT NULL,
  sent_at       TEXT,
  completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  signing_order INTEGER NOT NULL DEFAULT 1,
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | viewed | signed | declined
  viewed_at     TEXT,
  consent_at    TEXT,
  signed_at     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  decline_reason TEXT
);

CREATE TABLE IF NOT EXISTS fields (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id  TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  page          INTEGER NOT NULL,        -- 1-based
  type          TEXT NOT NULL,           -- signature | initials | date | text | name | checkbox | dropdown | radio
  x_ratio       REAL NOT NULL,           -- top-left, fraction of page width
  y_ratio       REAL NOT NULL,           -- top-left, fraction of page height (from top)
  w_ratio       REAL NOT NULL,
  h_ratio       REAL NOT NULL,
  required      INTEGER NOT NULL DEFAULT 1,
  value         TEXT,                    -- filled at signing (text or PNG data URL)
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id  TEXT,
  event_type    TEXT NOT NULL,
  detail        TEXT,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  fields        TEXT NOT NULL,           -- JSON: [{role, page, type, x_ratio, y_ratio, w_ratio, h_ratio, required, options}]
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipients_doc  ON recipients(document_id);
CREATE INDEX IF NOT EXISTS idx_fields_doc       ON fields(document_id);
CREATE INDEX IF NOT EXISTS idx_fields_recipient ON fields(recipient_id);
CREATE INDEX IF NOT EXISTS idx_audit_doc        ON audit_events(document_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_owner  ON templates(owner_id);
`);

// Additive migrations for columns introduced after the first release.
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumn('documents', 'owner_id', 'TEXT');
addColumn('recipients', 'invited_at', 'TEXT');
addColumn('documents', 'tsa_time', 'TEXT');       // TSA-asserted genTime (RFC-3161)
addColumn('documents', 'tsa_url', 'TEXT');
addColumn('documents', 'tsr_path', 'TEXT');       // stored timestamp token (.tsr)
addColumn('fields', 'options', 'TEXT');           // JSON array of choices (dropdown | radio)
addColumn('recipients', 'access_code_hash', 'TEXT');  // optional signer access code (scrypt)
addColumn('recipients', 'code_verified_at', 'TEXT');
addColumn('documents', 'cc_list', 'TEXT');        // JSON [{name, email}] notified on completion
addColumn('documents', 'archived_at', 'TEXT');    // archived docs are hidden from the default list
addColumn('recipients', 'token_expires_at', 'TEXT'); // signing links expire (LINK_EXPIRY_DAYS)

// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3),
// so wrap BEGIN/COMMIT/ROLLBACK manually.
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export default db;
