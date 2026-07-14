const docId = new URLSearchParams(location.search).get('id');
const content = document.getElementById('content');

load();

async function load() {
  const res = await fetch(`/api/documents/${docId}/audit`);
  if (!res.ok) { content.innerHTML = '<div class="empty">Document not found.</div>'; return; }
  const { document: d, recipients, events } = await res.json();
  const base = location.origin;

  const links = recipients
    .filter((r) => r.status !== 'signed')
    .map((r) => `<div><strong>${esc(r.name)}</strong> &lt;${esc(r.email)}&gt;<br>
      <a href="${base}/sign.html?t=${r.token}" target="_blank">${base}/sign.html?t=${r.token}</a></div>`)
    .join('');

  content.innerHTML = `
    <h1>${esc(d.title)} <span class="pill ${d.status}">${d.status}</span></h1>
    <p class="sub">${esc(d.original_name)}</p>

    <div style="display:flex; gap:10px; margin-bottom:20px">
      ${d.status === 'completed' ? `<a class="btn primary" href="/api/documents/${d.id}/final">⬇ Download signed PDF</a>` : ''}
      <a class="btn" href="/api/documents/${d.id}/file" target="_blank">View original</a>
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
    </div>`;

  const voidBtn = document.getElementById('voidBtn');
  if (voidBtn) voidBtn.onclick = async () => {
    if (!confirm('Void this document? Signers will no longer be able to sign.')) return;
    await fetch(`/api/documents/${d.id}/void`, { method: 'POST' });
    load();
  };
}

function recipRow(r) {
  return `<tr>
    <td><strong>${esc(r.name)}</strong></td>
    <td class="muted">${esc(r.email)}</td>
    <td><span class="pill ${r.status === 'signed' ? 'completed' : r.status === 'declined' ? 'voided' : 'sent'}">${r.status}</span></td>
    <td class="muted">${r.signed_at ? new Date(r.signed_at).toLocaleString() : '—'}</td>
    <td class="muted">${r.ip || '—'}</td>
  </tr>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
