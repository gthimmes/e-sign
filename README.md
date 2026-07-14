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
   (signature, initials, date, full name, text) onto the pages. Fields are
   color-coded per signer and can be dragged/resized.
4. **Send** — the document is locked, hashed (SHA-256), a unique tokenized signing
   link is minted per signer, and an **email invitation** is sent to whoever's turn
   it is (respecting signing order). Links are also shown on screen / logged.
5. **Sign** — each signer opens their link, is shown an ESIGN/UETA consent
   disclosure they must accept, then fills their fields. Signatures can be drawn or
   typed. Signing order is enforced; the next signer is emailed automatically.
6. **Complete** — once everyone signs, InkWell stamps the signatures into the PDF,
   appends a **Certificate of Completion** (the full audit trail), applies a
   **cryptographic PKCS#7 seal** over the whole document, and emails all parties.
   The sealed PDF is available for download.

## Configuration (environment variables)

All optional — sensible local defaults are used if unset.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Real email delivery. With no `SMTP_HOST`, emails are **logged to the console only** and never sent — safe for local dev. |
| `MAIL_FROM` | From address for outgoing mail |
| `SEAL_PASSPHRASE`, `SEAL_CN`, `SEAL_ORG`, `SEAL_COUNTRY` | Signing-certificate passphrase and subject |
| `COOKIE_SECURE` | Set `true` behind HTTPS so the session cookie is secure-only |

## What makes the signatures "legit"

| Legal requirement | How InkWell satisfies it |
|---|---|
| Intent to sign | Explicit draw/type + "Finish & submit" confirmation |
| Consent to e-records | Mandatory ESIGN/UETA disclosure + checkbox before signing |
| Attribution | Unique per-signer email + unguessable token; IP, user-agent, timestamps captured |
| Integrity / tamper-evidence | SHA-256 at send + at completion, **plus a PKCS#7 digital seal** over the finished PDF (verifiable in Adobe Reader) |
| Audit trail | Every action logged (created, sent, invited, viewed, consented, signed, sealed, completed) |
| Retention | Original + sealed PDF + audit stored and downloadable; certificate embedded in the final PDF |

## Architecture

```
server.js         Express API + auth middleware + static host
db.js             node:sqlite schema + transaction helper + migrations
lib/audit.js      hashing, tokens, audit-event logging
lib/pdfStamp.js   stamps fields + appends the Certificate of Completion (pdf-lib)
lib/pki.js        self-signed signing cert + PKCS#7 sealing (@signpdf, node-forge)
lib/auth.js       scrypt passwords + server-side sessions (httpOnly cookie)
lib/email.js      nodemailer transport (SMTP or console-log fallback)
public/           login, dashboard, prepare editor, signer view, status page
  js/pdfview.js   pdf.js rendering wrapper
  js/sigpad.js    draw/type signature capture
  js/session.js   client-side auth guard
  vendor/         vendored pdf.js browser build
```

Data model: `users` → `documents` → `recipients` → `fields`, plus an append-only
`audit_events` log and `sessions`.

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

## Honest limitations (this is still a basic app)

- **Stronger identity verification** — email + link proves control of an inbox, not
  legal identity. Add SMS/OTP, knowledge-based auth, or ID verification for
  high-value agreements.
- **Trusted timestamping** — the seal uses the server's clock; a production system
  would add an RFC-3161 TSA timestamp and long-term validation (LTV) so signatures
  remain verifiable after the certificate expires.
- **Publicly-trusted signing certificate** — swap the self-signed cert for one from
  a CA in Adobe's Approved Trust List (AATL) to get a green check in Reader.
- **Password reset & email verification** flows for sender accounts.
- **Encryption at rest**, backups, rate limiting, and retention policies.

Not legal advice — consult counsel for your jurisdiction and use case.
