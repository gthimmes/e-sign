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
account, no native build step.

## How it works

1. **Upload** a PDF on the dashboard.
2. **Prepare** — add each signer (name + email) and click to drop fields
   (signature, initials, date, full name, text) onto the pages. Fields are
   color-coded per signer and can be dragged/resized.
3. **Send** — the document is locked, hashed (SHA-256), and a unique tokenized
   signing link is minted for each signer. In this local build the links are shown
   on screen and printed to the server console instead of being emailed.
4. **Sign** — each signer opens their link, is shown an ESIGN/UETA consent
   disclosure they must accept, then fills their fields. Signatures can be drawn or
   typed. Signing order is enforced when signers have different orders.
5. **Complete** — once everyone signs, InkWell stamps the signatures into the PDF,
   appends a **Certificate of Completion** (the full audit trail), hashes the final
   file, and makes it available for download.

## What makes the signatures "legit"

| Legal requirement | How InkWell satisfies it |
|---|---|
| Intent to sign | Explicit draw/type + "Finish & submit" confirmation |
| Consent to e-records | Mandatory ESIGN/UETA disclosure + checkbox before signing |
| Attribution | Unique per-signer email + unguessable token; IP, user-agent, timestamps captured |
| Integrity / tamper-evidence | SHA-256 of the document at send and at completion |
| Audit trail | Every action logged (created, sent, viewed, consented, signed, completed) |
| Retention | Original + final PDF + audit stored and downloadable; certificate embedded in the final PDF |

## Architecture

```
server.js         Express API + static host
db.js             node:sqlite schema + transaction helper
lib/audit.js      hashing, tokens, audit-event logging
lib/pdfStamp.js   stamps fields + appends the Certificate of Completion (pdf-lib)
public/           dashboard, prepare editor, signer view, status page
  js/pdfview.js   pdf.js rendering wrapper
  js/sigpad.js    draw/type signature capture
  vendor/         vendored pdf.js browser build
```

Data model: `documents` → `recipients` → `fields`, plus an append-only
`audit_events` log.

## Honest limitations (this is a basic app)

This demonstrates the mechanics and a legally-sound audit trail, but a production
service would additionally want:

- **Stronger identity verification** — email + link proves control of an inbox, not
  legal identity. Add SMS/OTP, knowledge-based auth, or ID verification for
  high-value agreements.
- **Real email delivery** — links are currently displayed rather than emailed.
- **Cryptographic document signing** — a PKI digital signature (PAdES) with a
  trusted timestamp (RFC 3161 TSA) would make tamper-evidence cryptographically
  verifiable in any PDF reader, on top of the SHA-256 hashes used here.
- **Authentication for the sender dashboard** — currently open on localhost.
- **Encryption at rest**, backups, and retention policies.
- **Long-term validation (LTV)** for signatures.

Not legal advice — consult counsel for your jurisdiction and use case.
