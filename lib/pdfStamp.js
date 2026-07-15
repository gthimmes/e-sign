// Renders the finished document: stamps every field value onto the original
// PDF and appends a Certificate of Completion (the human-readable audit trail).
import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sha256, getEvents } from './audit.js';

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

// value strings for signature/initials fields are PNG data URLs.
function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1] || '';
  return Buffer.from(b64, 'base64');
}

export async function buildFinalPdf({ document, recipients, fields, certInfo = null }) {
  const originalBytes = await fs.readFile(document.file_path);
  const pdf = await PDFDocument.load(originalBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  const recipById = Object.fromEntries(recipients.map((r) => [r.id, r]));

  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const pw = page.getWidth();
    const ph = page.getHeight();
    const x = f.x_ratio * pw;
    const w = f.w_ratio * pw;
    const h = f.h_ratio * ph;
    const yTopFromTop = f.y_ratio * ph;
    const yBottom = ph - yTopFromTop - h; // pdf-lib origin is bottom-left

    if (f.type === 'checkbox') {
      // Draw a square outline, and an X-style check mark when ticked.
      const s = Math.min(w, h);
      const bx = x + (w - s) / 2;
      const by = yBottom + (h - s) / 2;
      page.drawRectangle({ x: bx, y: by, width: s, height: s, borderColor: INK, borderWidth: 1 });
      if (f.value === 'true') {
        const pad = s * 0.22;
        const t = Math.max(1.4, s * 0.09);
        // Two strokes forming a check mark within the box.
        page.drawLine({ start: { x: bx + pad, y: by + s * 0.5 }, end: { x: bx + s * 0.42, y: by + pad }, thickness: t, color: INK });
        page.drawLine({ start: { x: bx + s * 0.42, y: by + pad }, end: { x: bx + s - pad, y: by + s - pad }, thickness: t, color: INK });
      }
    } else if ((f.type === 'signature' || f.type === 'initials') && f.value?.startsWith('data:image')) {
      const png = await pdf.embedPng(dataUrlToBytes(f.value));
      // Fit the signature inside the box, preserving aspect ratio.
      const scale = Math.min(w / png.width, h / png.height);
      const dw = png.width * scale;
      const dh = png.height * scale;
      page.drawImage(png, {
        x: x + (w - dw) / 2,
        y: yBottom + (h - dh) / 2,
        width: dw,
        height: dh,
      });
    } else if (f.value) {
      const size = Math.min(h * 0.7, 14);
      page.drawText(String(f.value), {
        x: x + 2,
        y: yBottom + (h - size) / 2 + 1,
        size,
        font: helv,
        color: INK,
      });
    }
  }

  await appendCertificate(pdf, { document, recipients, recipById, helv, helvBold, certInfo });

  // useObjectStreams:false keeps a classic xref table so the digital-signature
  // byte offsets added during sealing remain valid.
  const finalBytes = await pdf.save({ useObjectStreams: false });
  return { bytes: Buffer.from(finalBytes), sha256: sha256(Buffer.from(finalBytes)) };
}

async function appendCertificate(pdf, { document, recipients, helv, helvBold, certInfo }) {
  const events = getEvents(document.id);
  let page = pdf.addPage([612, 792]); // US Letter
  const M = 54;
  let y = 792 - M;

  const text = (s, { x = M, size = 10, font = helv, color = INK, gap = 14 } = {}) => {
    page.drawText(String(s), { x, y, size, font, color });
    y -= gap;
  };
  const rule = () => {
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: 612 - M, y: y + 4 }, thickness: 0.75, color: RULE });
    y -= 10;
  };
  const ensure = (need = 40) => {
    if (y < M + need) {
      page = pdf.addPage([612, 792]);
      y = 792 - M;
    }
  };

  text('Certificate of Completion', { size: 18, font: helvBold, gap: 10 });
  text('InkWell e-signature — audit record (U.S. ESIGN Act / UETA)', { size: 9, color: MUTED, gap: 18 });

  text('Document', { size: 11, font: helvBold });
  text(`Title:  ${document.title}`);
  text(`Original file:  ${document.original_name}`);
  text(`Document ID:  ${document.id}`);
  text(`Status:  ${document.status}`);
  text(`Created:  ${fmt(document.created_at)}`);
  text(`Sent:  ${fmt(document.sent_at)}`);
  text(`Completed:  ${fmt(document.completed_at)}`);
  text(`SHA-256 (at send):  ${document.sha256_sent || '—'}`, { size: 8, color: MUTED, gap: 12 });
  y -= 4;
  rule();

  text('Signers', { size: 11, font: helvBold });
  for (const r of recipients) {
    ensure(90);
    text(`${r.name}  <${r.email}>`, { font: helvBold });
    text(`Status:  ${r.status}`, { color: MUTED });
    text(`Consented to electronic records:  ${fmt(r.consent_at)}`, { color: MUTED });
    text(`Signed:  ${fmt(r.signed_at)}`, { color: MUTED });
    text(`IP address:  ${r.ip || '—'}`, { color: MUTED });
    text(`Device:  ${trim(r.user_agent, 78)}`, { size: 8, color: MUTED, gap: 16 });
  }
  rule();

  text('Event history', { size: 11, font: helvBold });
  for (const e of events) {
    ensure(24);
    text(`${fmt(e.created_at)}   ${e.event_type}${e.detail ? '  — ' + e.detail : ''}`, {
      size: 8,
      color: MUTED,
      gap: 11,
    });
    if (e.ip) {
      ensure(18);
      text(`     from ${e.ip}`, { size: 7, color: MUTED, gap: 11 });
    }
  }

  ensure(30);
  y -= 6;
  rule();
  text('This certificate is a system-generated record of the electronic signing process.', {
    size: 7.5,
    color: MUTED,
    gap: 10,
  });
  text('Each signer consented to conduct business electronically and applied their signature with intent to sign.', {
    size: 7.5,
    color: MUTED,
    gap: 12,
  });

  if (certInfo) {
    ensure(40);
    text('Digital seal', { size: 9, font: helvBold, gap: 12 });
    text('After completion this document is sealed with a PKCS#7 digital signature, making it tamper-evident.', {
      size: 7.5, color: MUTED,
    });
    text(`Sealing certificate:  ${certInfo.subject}`, { size: 7.5, color: MUTED });
    text(`Certificate SHA-256:  ${certInfo.fingerprintSha256}`, { size: 7, color: MUTED, gap: 12 });
    // The trusted timestamp is applied over the sealed bytes, so it can't be shown
    // inside this page. We note that one was requested; the token is a separate
    // artifact recorded in the audit trail and downloadable from the status page.
    ensure(24);
    text('A trusted RFC-3161 timestamp is applied to the sealed document; see the audit trail for details.', {
      size: 7, color: MUTED,
    });
  }
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toUTCString();
}
function trim(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
