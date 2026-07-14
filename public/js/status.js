import { requireSession } from '/js/session.js';

const docId = new URLSearchParams(location.search).get('id');
const content = document.getElementById('content');

if (await requireSession()) load();

async function load() {
  const res = await fetch(`/api/documents/${docId}/audit`);
  if (!res.ok) { content.innerHTML = '<div class="empty">Document not found.</div>'; return; }
  const { document: d, recipients, events, certInfo } = await res.json();
  const base = location.origin;
  const isSealed = events.some((e) => e.event_type === 'document.sealed');

  const links = recipients
    .filter((r) => r.status !== 'signed')
    .map((r) => `<div><strong>${esc(r.name)}</strong> &lt;${esc(r.email)}&gt;<br>
      <a href="${base}/sign.html?t=${r.token}" target="_blank">${base}/sign.html?t=${r.token}</a></div>`)
    .join('');

  content.innerHTML = `
    <h1>${esc(d.title)} <span class="pill ${d.status}">${d.status}</span></h1>
    <p class="sub">${esc(d.original_name)}</p>

    <div style="display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap">
      ${d.status === 'completed' ? `<a class="btn primary" href="/api/documents/${d.id}/final">⬇ Download signed PDF</a>` : ''}
      ${d.tsr_path ? `<a class="btn" href="/api/documents/${d.id}/timestamp">⬇ Timestamp token (.tsr)</a>` : ''}
      <a class="btn" href="/api/documents/${d.id}/file" target="_blank">View original</a>
      ${d.status === 'sent' ? `<button class="btn" id="remindBtn">✉ Send reminder</button>` : ''}
      ${d.status === 'sent' ? `<button class="btn danger" id="voidBtn">Void document</button>` : ''}
    </div>

    <div class="card pad" style="margin-bottom:16px">
      <h2>Signers</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Signed</th><th>IP</th></tr></thead>
        <tbody>${recipients.map(recipRow).join('')}</tbody>
      </table>
    </div>

    ${links && d.status === 'sent' ? `<div class="card pad" style="margin-bottom:16px">
      <h2>Pending signing links</h2>
      <div class="linklist">${links}</div></div>` : ''}

    <div class="card pad">
      <h2>Audit trail</h2>
      <div class="linklist" style="font-size:12px">
        ${events.map((e) => `<div>
          <span class="muted">${new Date(e.created_at).toLocaleString()}</span> &nbsp;
          <strong>${esc(e.event_type)}</strong>
          ${e.detail ? '— ' + esc(e.detail) : ''}
          ${e.ip ? `<span class="muted"> · ${esc(e.ip)}</span>` : ''}
        </div>`).join('')}
      </div>
      <p class="muted" style="font-size:12px; margin-top:12px">
        Integrity hash at send (SHA-256): <code>${d.sha256_sent || '—'}</code><br>
        ${d.sha256_final ? `Final document (SHA-256): <code>${d.sha256_final}</code>` : ''}
      </p>
    </div>

    ${isSealed ? `<div class="card pad" style="margin-top:16px">
      <h2>Digital seal</h2>
      <p class="muted" style="font-size:13px; margin-top:0">The completed PDF is sealed with a PKCS#7 digital signature — any change after sealing is cryptographically detectable and verifiable in Adobe Reader.</p>
      <div class="linklist" style="font-size:12px">
        <div>Certificate: <strong>${esc(certInfo?.subject || '—')}</strong></div>
        <div>Fingerprint (SHA-256): <code>${esc(certInfo?.fingerprintSha256 || '—')}</code></div>
        <div>Valid: ${certInfo?.notBefore ? new Date(certInfo.notBefore).toLocaleDateString() : '—'} → ${certInfo?.notAfter ? new Date(certInfo.notAfter).toLocaleDateString() : '—'}</div>
      </div>
      ${d.tsa_time ? `<h2 style="margin-top:18px">Trusted timestamp (RFC-3161)</h2>
        <p class="muted" style="font-size:13px; margin-top:0">An independent Time-Stamping Authority attests the sealed document existed at this time. Verify with <code>openssl ts -verify</code>.</p>
        <div class="linklist" style="font-size:12px">
          <div>Asserted time: <strong>${new Date(d.tsa_time).toUTCString()}</strong></div>
          <div>Authority: <code>${esc(d.tsa_url || '—')}</code></div>
        </div>` : ''}
    </div>` : ''}`;

  const voidBtn = document.getElementById('voidBtn');
  if (voidBtn) voidBtn.onclick = async () => {
    if (!confirm('Void this document? Signers will no longer be able to sign.')) return;
    await fetch(`/api/documents/${d.id}/void`, { method: 'POST' });
    load();
  };

  const remindBtn = document.getElementById('remindBtn');
  if (remindBtn) remindBtn.onclick = async () => {
    remindBtn.disabled = true;
    const res = await fetch(`/api/documents/${d.id}/remind`, { method: 'POST' });
    const data = await res.json();
    remindBtn.disabled = false;
    if (!res.ok) return toast(data.error || 'Could not send reminder.');
    toast(`Reminder sent to ${data.reminded.join(', ')}${data.emailMode === 'log-only' ? ' (logged)' : ''}.`);
    load();
  };
}

function recipRow(r) {
  const pill = r.status === 'signed' ? 'completed' : r.status === 'declined' ? 'voided' : 'sent';
  return `<tr>
    <td><strong>${esc(r.name)}</strong>${r.status === 'declined' && r.decline_reason ? `<div class="muted" style="font-size:12px">Reason: ${esc(r.decline_reason)}</div>` : ''}</td>
    <td class="muted">${esc(r.email)}</td>
    <td><span class="pill ${pill}">${r.status}</span></td>
    <td class="muted">${r.signed_at ? new Date(r.signed_at).toLocaleString() : '—'}</td>
    <td class="muted">${r.ip || '—'}</td>
  </tr>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
