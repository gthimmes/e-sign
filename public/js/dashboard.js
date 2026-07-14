import { requireSession } from '/js/session.js';

const rows = document.getElementById('rows');
const drop = document.getElementById('drop');
const file = document.getElementById('file');
const uploadCard = document.getElementById('uploadCard');

document.getElementById('newBtn').onclick = () => {
  uploadCard.style.display = uploadCard.style.display === 'none' ? '' : 'none';
};

drop.onclick = () => file.click();
['dragover', 'dragenter'].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('hot'); })
);
['dragleave', 'drop'].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('hot'); })
);
drop.addEventListener('drop', (ev) => { if (ev.dataTransfer.files[0]) uploadFile(ev.dataTransfer.files[0]); });
file.addEventListener('change', () => { if (file.files[0]) uploadFile(file.files[0]); });

async function uploadFile(f) {
  if (f.type !== 'application/pdf') return toast('Only PDF files are supported.');
  drop.innerHTML = 'Uploading…';
  const fd = new FormData();
  fd.append('pdf', f);
  fd.append('title', f.name.replace(/\.pdf$/i, ''));
  const res = await fetch('/api/documents', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Upload failed'); resetDrop(); return; }
  location.href = `/prepare.html?id=${data.id}`;
}
function resetDrop() {
  drop.innerHTML = '<strong>Click to choose</strong> or drop a PDF here';
}

async function load() {
  const docs = await (await fetch('/api/documents')).json();
  if (!docs.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No documents yet. Click “New document” to begin.</td></tr>';
    return;
  }
  rows.innerHTML = '';
  for (const d of docs) {
    const tr = document.createElement('tr');
    tr.className = 'row-link';
    const created = new Date(d.created_at).toLocaleString();
    tr.innerHTML = `
      <td><strong>${esc(d.title)}</strong><div class="muted" style="font-size:12px">${esc(d.original_name)}</div></td>
      <td><span class="pill ${d.status}">${d.status}</span></td>
      <td>${d.signed}/${d.signers}</td>
      <td class="muted">${created}</td>
      <td style="text-align:right">${actions(d)}</td>`;
    tr.querySelector('td').onclick = () => open(d);
    tr.children[1].onclick = () => open(d);
    rows.appendChild(tr);
  }
}

function actions(d) {
  if (d.status === 'draft') return `<button class="btn sm" data-go="prepare" data-id="${d.id}">Prepare</button>`;
  if (d.status === 'completed')
    return `<a class="btn sm primary" href="/api/documents/${d.id}/final">Download</a>
            <button class="btn sm" data-go="audit" data-id="${d.id}">Audit</button>`;
  return `<button class="btn sm" data-go="status" data-id="${d.id}">View</button>`;
}

function open(d) {
  if (d.status === 'draft') location.href = `/prepare.html?id=${d.id}`;
  else location.href = `/status.html?id=${d.id}`;
}

rows.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  if (btn.dataset.go === 'prepare') location.href = `/prepare.html?id=${id}`;
  else location.href = `/status.html?id=${id}`;
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

const session = await requireSession();
if (session) load();
