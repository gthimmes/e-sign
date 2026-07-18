// Email delivery via nodemailer.
//
// Configure real SMTP with env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// SMTP_SECURE, MAIL_FROM). With no SMTP configured, a safe "log only" transport is
// used: messages are printed to the server console and never sent over the network,
// so local development can't accidentally email real people.
import nodemailer from 'nodemailer';

const FROM = process.env.MAIL_FROM || 'InkWell e-Sign <no-reply@inkwell.local>';
const configured = !!process.env.SMTP_HOST;

const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true }); // logs, never delivers

export const emailMode = configured ? 'smtp' : 'log-only';

async function send({ to, subject, html, text }) {
  const info = await transport.sendMail({ from: FROM, to, subject, html, text });
  if (!configured) {
    console.log(`\n[email:log-only] → ${to}\n  subject: ${subject}\n  ${text?.split('\n').join('\n  ')}`);
  } else {
    console.log(`[email:smtp] sent to ${to} (id ${info.messageId})`);
  }
  return info;
}

const shell = (title, body) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
  <div style="font-size:20px;font-weight:700;padding:8px 0"><span style="background:#4f46e5;color:#fff;border-radius:6px;padding:2px 7px">✒</span> InkWell</div>
  <h2 style="font-size:18px">${title}</h2>${body}
  <p style="color:#64748b;font-size:12px;margin-top:24px">This is an automated message from InkWell e-Sign.</p>
</div>`;

const btn = (url, label) =>
  `<p><a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${label}</a></p>`;

export async function sendInvitation({ recipient, document, url }) {
  // If the sender set an access code, say so — but never include the code
  // itself; the sender shares it through a separate channel.
  const codeNote = recipient.access_code_hash
    ? '\n\nThe sender has protected this document with an access code. You will be asked to enter it — contact the sender if you have not received it.'
    : '';
  const codeNoteHtml = recipient.access_code_hash
    ? `<p style="background:#fefce8;border-radius:8px;padding:10px 12px;color:#854d0e;font-size:13px">🔒 The sender has protected this document with an <strong>access code</strong>. You'll be asked to enter it — contact the sender if you haven't received it.</p>`
    : '';
  return send({
    to: `${recipient.name} <${recipient.email}>`,
    subject: `Signature requested: ${document.title}`,
    text: `Hello ${recipient.name},\n\nYou have been asked to sign "${document.title}".\nReview and sign here:\n${url}${codeNote}\n\nThank you,\nInkWell e-Sign`,
    html: shell(`You've been asked to sign “${escapeHtml(document.title)}”`,
      `<p>Hello ${escapeHtml(recipient.name)},</p><p>Please review and apply your signature.</p>${btn(url, 'Review & sign')}
       ${codeNoteHtml}
       <p style="color:#64748b;font-size:12px">Or paste this link: ${url}</p>`),
  });
}

export async function sendCompletion({ recipient, document, url }) {
  return send({
    to: `${recipient.name} <${recipient.email}>`,
    subject: `Completed: ${document.title}`,
    text: `Hello ${recipient.name},\n\n"${document.title}" has been signed by all parties and sealed.\n${url ? 'View status: ' + url : ''}\n\nThank you,\nInkWell e-Sign`,
    html: shell(`“${escapeHtml(document.title)}” is complete`,
      `<p>Hello ${escapeHtml(recipient.name)},</p><p>All parties have signed. The document has been cryptographically sealed.</p>
       ${url ? btn(url, 'View status & download') : ''}`),
  });
}

export async function sendDeclined({ to, name, document, declinedBy, reason, url }) {
  return send({
    to: `${name} <${to}>`,
    subject: `Declined: ${document.title}`,
    text: `Hello ${name},\n\n${declinedBy} has declined to sign "${document.title}".${reason ? `\nReason: ${reason}` : ''}\nThe document has been voided.\n${url ? 'View status: ' + url : ''}\n\nInkWell e-Sign`,
    html: shell(`“${escapeHtml(document.title)}” was declined`,
      `<p>Hello ${escapeHtml(name)},</p><p><strong>${escapeHtml(declinedBy)}</strong> has declined to sign this document, so it has been voided.</p>
       ${reason ? `<p style="background:#fef2f2;border-radius:8px;padding:10px 12px;color:#991b1b">Reason: ${escapeHtml(reason)}</p>` : ''}
       ${url ? btn(url, 'View status') : ''}`),
  });
}

export async function sendReminder({ recipient, document, url }) {
  return send({
    to: `${recipient.name} <${recipient.email}>`,
    subject: `Reminder — please sign: ${document.title}`,
    text: `Hello ${recipient.name},\n\nThis is a reminder that "${document.title}" is waiting for your signature.\nReview and sign here:\n${url}\n\nThank you,\nInkWell e-Sign`,
    html: shell(`Reminder: “${escapeHtml(document.title)}” awaits your signature`,
      `<p>Hello ${escapeHtml(recipient.name)},</p><p>This is a friendly reminder to review and sign.</p>${btn(url, 'Review & sign')}
       <p style="color:#64748b;font-size:12px">Or paste this link: ${url}</p>`),
  });
}

export async function sendPasswordReset({ user, url }) {
  return send({
    to: `${user.name || user.email} <${user.email}>`,
    subject: 'Reset your InkWell password',
    text: `Hello,\n\nA password reset was requested for your InkWell account.\nReset it here (link valid for 1 hour):\n${url}\n\nIf you didn't request this, you can ignore this message.\n\nInkWell e-Sign`,
    html: shell('Reset your password',
      `<p>A password reset was requested for your InkWell account.</p>${btn(url, 'Choose a new password')}
       <p style="color:#64748b;font-size:12px">The link is valid for 1 hour. If you didn't request this, ignore this message.</p>`),
  });
}

export async function sendVerification({ user, url }) {
  return send({
    to: `${user.name || user.email} <${user.email}>`,
    subject: 'Verify your InkWell email',
    text: `Hello,\n\nPlease confirm this email address for your InkWell account:\n${url}\n\nIf you didn't create this account, you can ignore this message.\n\nInkWell e-Sign`,
    html: shell('Confirm your email',
      `<p>Please confirm this email address for your InkWell account.</p>${btn(url, 'Verify email')}
       <p style="color:#64748b;font-size:12px">If you didn't create this account, ignore this message.</p>`),
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
