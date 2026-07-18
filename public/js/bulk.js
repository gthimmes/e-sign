import { requireSession } from '/js/session.js';

const el = (id) => document.getElementById(id);

if (await requireSession()) init();

async function init() {
  const [docs, tplRes] = await Promise.all([
    fetch('/api/documents').then((r) => r.json()),
    fetch('/api/templates').then((r) => r.json()),
  ]);

  const drafts = docs.filter((d) => d.status === 'draft');
  el('docSelect').innerHTML = drafts.length
    ? '<option value="">Choose a document…</option>' +
      drafts.map((d) => `<option value="${d.id}">${esc(d.title)} (${esc(d.original_name)})</option>`).join('')
    : '<option value="">No drafts — upload a PDF from the dashboard first</option>';

  // Bulk send maps every field to the one recipient, so only 1-signer templates apply.
  const singles = tplRes.templates.filter((t) => t.fields.every((f) => f.role === 1));
  el('tplSelect').innerHTML = singles.length
    ? '<option value="">Choose a template…</option>' +
      singles.map((t) => `<option value="${t.id}">${esc(t.name)} · ${t.fields.length} field(s)</option>`).join('')
    : '<option value="">No single-signer templates — save one from the prepare editor</option>';
}

// Accepts "Name, email" or "Name <email>" per line.
function parseRecipients(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const angle = s.match(/^(.*?)[\s,]*<([^>]+)>\s*$/);
    if (angle) { out.push({ name: angle[1].trim(), email: angle[2].trim() }); continue; }
    const comma = s.split(',');
    if (comma.length >= 2) {
      out.push({ name: comma.slice(0, -1).join(',').trim(), email: comma[comma.length - 1].trim() });
      continue;
    }
    out.push({ name: '', email: s }); // will fail server validation with a pointed message
  }
  return out;
}

el('sendBtn').onclick = async () => {
  const docId = el('docSelect').value;
  const templateId = el('tplSelect').value;
  const recipients = parseRecipients(el('recipients').value);
  if (!docId) return toast('Choose a draft document.');
  if (!templateId) return toast('Choose a template.');
  if (!recipients.length) return toast('Add at least one recipient.');

  el('sendBtn').disabled = true;
  el('sendBtn').textContent = `Sending to ${recipients.length}…`;
  const res = await fetch(`/api/documents/${docId}/bulk-send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId, recipients }),
  });
  const data = await res.json();
  el('sendBtn').disabled = false;
  el('sendBtn').textContent = 'Send to all →';
  if (!res.ok) return toast(data.error || 'Bulk send failed.');

  el('result').innerHTML =
    `<div class="banner ok">Sent ${data.created.length} document(s)${data.emailMode === 'log-only' ? ' — invitations logged to the server console (no SMTP configured)' : ' — invitations emailed'}.</div>
    <div class="card pad" style="margin-top:12px"><h2>Signing links</h2><div class="linklist">` +
    data.created.map((c) => `<div><strong>${esc(c.name)}</strong> &lt;${esc(c.email)}&gt; ·
      <a href="/status.html?id=${c.documentId}">track</a><br>
      <a href="${c.url}" target="_blank">${c.url}</a></div>`).join('') +
    '</div></div>';
};

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
