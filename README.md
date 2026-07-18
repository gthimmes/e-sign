# InkWell — a basic e-signature application

Upload a PDF, mark where signatures go, send it out, and collect legally-defensible
electronic signatures — with a full audit trail and a Certificate of Completion.

Built to align with the U.S. **ESIGN Act** and **UETA**, which make an electronic
signature enforceable when you can show four things: **intent to sign**, **consent to
do business electronically**, **attribution** (the signature is tied to a person), and
a **retained, tamper-evident record**. InkWell captures all four.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000

npm test    # 67-check end-to-end regression suite (isolated scratch DB, no network needed)
```

Requires Node 22.5+ (uses the built-in `node:sqlite`). No database server, no cloud
account, no native build step. First run generates a self-signed signing
certificate under `data/signing.p12` (keep it private — it's gitignored).

You'll be prompted to **create an account** on first visit; the dashboard and all
authoring actions require signing in. Signer links stay public and token-based.

## How it works

1. **Sign in** (or create an account) to reach your dashboard.
2. **Upload** a PDF.
3. **Prepare** — add each signer (name + email) and click to drop fields
   (signature, initials, date, full name, text, checkbox, dropdown, radio group)
   onto the pages. Fields
   are color-coded per signer and can be dragged/resized. A finished layout can be
   **saved as a template** (positions stored per signer number) and applied to any
   future PDF with one click. With a single-signer template you can also **bulk
   send**: one draft PDF fans out to up to 100 recipients, each getting their own
   independent document, signing link, audit trail, and sealed final PDF.
4. **Send** — the document is locked, hashed (SHA-256), a unique tokenized signing
   link is minted per signer, and an **email invitation** is sent to whoever's turn
   it is (respecting signing order). Links are also shown on screen / logged.
5. **Sign** — each signer opens their link, is shown an ESIGN/UETA consent
   disclosure they must accept, then fills their fields. Signatures can be drawn or
   typed. Signing order is enforced; the next signer is emailed automatically. A
   signer who can't proceed may **decline with a reason**, which voids the document
   and notifies everyone. The sender can **send reminders** to whoever's turn it is.
6. **Complete** — once everyone signs, InkWell stamps the signatures into the PDF,
   appends a **Certificate of Completion** (the full audit trail), applies a
   **cryptographic PKCS#7 seal** over the whole document, obtains an **RFC-3161
   trusted timestamp** from a Time-Stamping Authority, and emails all parties. The
   sealed PDF and the timestamp token are available for download.

## Configuration (environment variables)

All optional — sensible local defaults are used if unset.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Real email delivery. With no `SMTP_HOST`, emails are **logged to the console only** and never sent — safe for local dev. |
| `MAIL_FROM` | From address for outgoing mail |
| `SEAL_PASSPHRASE`, `SEAL_CN`, `SEAL_ORG`, `SEAL_COUNTRY` | Signing-certificate passphrase and subject |
| `TSA_URL` | RFC-3161 Time-Stamping Authority endpoint (default `https://freetsa.org/tsr`). Timestamping is best-effort — if the TSA is unreachable, completion still succeeds and the audit trail records that it was skipped. |
| `COOKIE_SECURE` | Set `true` behind HTTPS so the session cookie is secure-only |
| `LINK_EXPIRY_DAYS` | Days before signing links expire (default 30). Sending a reminder automatically mints a fresh link for expired signers. |

## What makes the signatures "legit"

| Legal requirement | How InkWell satisfies it |
|---|---|
| Intent to sign | Explicit draw/type + "Finish & submit" confirmation |
| Consent to e-records | Mandatory ESIGN/UETA disclosure + checkbox before signing |
| Attribution | Unique per-signer email + unguessable token; optional per-signer **access code** (shared out-of-band, stored scrypt-hashed, verification audited); IP, user-agent, timestamps captured |
| Integrity / tamper-evidence | SHA-256 at send + at completion, a **PKCS#7 digital seal** over the finished PDF (verifiable in Adobe Reader), **plus an RFC-3161 trusted timestamp** proving when it existed |
| Audit trail | Every action logged (created, sent, invited, reminded, viewed, consented, signed, declined, sealed, timestamped, completed) |
| Retention | Original + sealed PDF + timestamp token + audit stored and downloadable; certificate embedded in the final PDF |
| Exportable evidence | Full audit record downloadable as JSON or CSV from the status page (signature images omitted from JSON for privacy) |

**Hardening in place:** credential endpoints (login/register) and signer-token
endpoints are rate-limited per IP (in-memory sliding window) to blunt brute-force and
token-guessing. Sessions are httpOnly cookies; passwords are scrypt-hashed.

## Architecture

```
server.js         Express API + auth middleware + static host
db.js             node:sqlite schema + transaction helper + migrations
lib/audit.js      hashing, tokens, audit-event logging
lib/pdfStamp.js   stamps fields + appends the Certificate of Completion (pdf-lib)
lib/pki.js        self-signed signing cert + PKCS#7 sealing (@signpdf, node-forge)
lib/tsa.js        RFC-3161 trusted timestamping (node-forge ASN.1)
lib/auth.js       scrypt passwords + server-side sessions (httpOnly cookie)
lib/email.js      nodemailer transport (SMTP or console-log fallback)
lib/ratelimit.js  in-memory per-IP sliding-window rate limiter
public/           login, dashboard, prepare editor, bulk send, signer view, status page
  js/pdfview.js   pdf.js rendering wrapper
  js/sigpad.js    draw/type signature capture
  js/session.js   client-side auth guard
  vendor/         vendored pdf.js browser build
```

Data model: `users` → `documents` → `recipients` → `fields`, plus an append-only
`audit_events` log, `sessions`, and per-user `templates` (reusable field layouts).

## How the cryptographic seal works

After the visual signatures and certificate page are rendered, InkWell applies a
**PKCS#7 detached signature** over the entire PDF using its own signing certificate
(the same "platform seal" model DocuSign/Adobe Sign use). This doesn't replace the
signers' intent — it makes the finished record **cryptographically tamper-evident**:
any byte changed after sealing invalidates the signature. Open the downloaded PDF in
Adobe Reader and you'll see a signature panel. Because the certificate is self-signed,
Reader shows "signer identity unknown" until you trust the cert — expected for a
locally-generated authority. The certificate's SHA-256 fingerprint is printed on the
Certificate of Completion and the document status page.

## Trusted timestamp (RFC-3161)

After sealing, InkWell sends the SHA-256 of the sealed PDF to a Time-Stamping
Authority and receives a signed **timestamp token** asserting the document existed at
a given time — independent of our own server clock. The token's message imprint is
verified against our hash, the TSA-asserted time is recorded in the audit trail, and
the token is downloadable as a `.tsr` from the status page. You can verify it
independently:

```bash
openssl ts -reply -token_in -in <document>.tsr -text   # inspect
```

This detached token proves *when*; it complements the PKCS#7 seal that proves
*integrity*.

## Honest limitations (this is still a basic app)

- **Stronger identity verification** — email + link proves control of an inbox, and
  the optional access code adds a something-you-know factor, but neither proves
  legal identity. Add SMS/OTP, knowledge-based auth, or ID verification for
  high-value agreements.
- **Embedded PAdES timestamp / LTV** — the RFC-3161 token is stored as a detached
  companion artifact rather than embedded inside the PDF's CMS signature as a PAdES
  document-timestamp. Embedding it (plus long-term validation material) would let
  Adobe Reader show the timestamp natively.
- **Publicly-trusted signing certificate** — swap the self-signed cert for one from
  a CA in Adobe's Approved Trust List (AATL) to get a green check in Reader.
- **Password reset & email verification** flows for sender accounts.
- **Encryption at rest**, backups, rate limiting, and retention policies.

Not legal advice — consult counsel for your jurisdiction and use case.
