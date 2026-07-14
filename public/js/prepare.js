import { renderPdf } from '/js/pdfview.js';
import { requireSession } from '/js/session.js';

const params = new URLSearchParams(location.search);
const docId = params.get('id');

const COLORS = ['#4f46e5', '#0891b2', '#db2777', '#16a34a', '#d97706', '#7c3aed'];
const FIELD_TYPES = [
  { type: 'signature', label: 'Signature', w: 175, h: 50 },
  { type: 'initials', label: 'Initials', w: 72, h: 46 },
  { type: 'date', label: 'Date signed', w: 130, h: 30 },
  { type: 'name', label: 'Full name', w: 165, h: 30 },
  { type: 'text', label: 'Text', w: 165, h: 30 },
];

let recipients = [];      // { key, name, email, color }
let fields = [];          // { key, recipientKey, page, x_ratio, y_ratio, w_ratio, h_ratio, type, required }
let activeRecipient = null;
let armedType = null;
let pagesInfo = [];       // from renderPdf
let keySeq = 1;

const el = (id) => document.getElementById(id);

if (await requireSession()) init();

async function init() {
  const res = await fetch(`/api/documents/${docId}`);
  if (!res.ok) { el('viewer').innerHTML = '<div class="empty">Document not found.</div>'; return; }
  const data = await res.json();
  el('docTitle').textContent = data.document.title;

  // Rehydrate any previously-saved draft.
  const keyById = {};
  data.recipients.forEach((r, i) => {
    const key = keySeq++;
    keyById[r.id] = key;
    recipients.push({ key, name: r.name, email: r.email, color: COLORS[i % COLORS.length] });
  });
  data.fields.forEach((f) => {
    fields.push({
      key: keySeq++, recipientKey: keyById[f.recipient_id], page: f.page,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
      type: f.type, required: !!f.required,
    });
  });
  if (!recipients.length) addRecipient();
  activeRecipient = recipients[0].key;

  renderRecipients();
  renderTools();

  pagesInfo = await renderPdf(`/api/documents/${docId}/file`, el('viewer'));
  pagesInfo.forEach((p) => {
    p.overlay.addEventListener('click', (e) => onPageClick(e, p));
  });
  drawFields();
}

// ---- recipients ----------------------------------------------------------

function addRecipient() {
  const key = keySeq++;
  recipients.push({ key, name: '', email: '', color: COLORS[(recipients.length) % COLORS.length] });
  activeRecipient = key;
  renderRecipients();
}

function renderRecipients() {
  const box = el('recipients');
  box.innerHTML = '';
  recipients.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'recipient';
    div.style.outline = r.key === activeRecipient ? `2px solid ${r.color}` : 'none';
    div.innerHTML = `
      <div class="head">
        <span class="swatch" style="background:${r.color}"></span>
        <strong style="flex:1">Signer ${recipients.indexOf(r) + 1}</strong>
        <button class="btn sm ghost" data-pick="${r.key}">${r.key === activeRecipient ? 'Selected' : 'Select'}</button>
        ${recipients.length > 1 ? `<button class="btn sm danger" data-del="${r.key}">✕</button>` : ''}
      </div>
      <input type="text" placeholder="Full name" data-f="name" data-k="${r.key}" value="${escAttr(r.name)}"/>
      <input type="email" placeholder="Email address" data-f="email" data-k="${r.key}" value="${escAttr(r.email)}" style="margin-top:6px"/>`;
    box.appendChild(div);
  });
  box.querySelectorAll('input').forEach((inp) => {
    inp.oninput = () => {
      const r = recipients.find((x) => x.key == inp.dataset.k);
      r[inp.dataset.f] = inp.value;
    };
  });
  box.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { activeRecipient = +b.dataset.pick; renderRecipients(); });
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeRecipient(+b.dataset.del));
}

function removeRecipient(key) {
  recipients = recipients.filter((r) => r.key !== key);
  fields = fields.filter((f) => f.recipientKey !== key);
  if (activeRecipient === key) activeRecipient = recipients[0]?.key;
  renderRecipients();
  drawFields();
}

el('addRecipient').onclick = addRecipient;

// ---- field tools ---------------------------------------------------------

function renderTools() {
  const box = el('tools');
  box.innerHTML = '';
  FIELD_TYPES.forEach((ft) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = ft.label;
    chip.onclick = () => {
      armedType = armedType === ft.type ? null : ft.type;
      renderTools();
      el('armedHint').textContent = armedType
        ? `Click on the document to place a “${ft.label}” field.`
        : 'Select a field above, then click on the document.';
    };
    if (armedType === ft.type) { chip.style.background = activeColor(); chip.style.color = '#fff'; chip.style.borderColor = activeColor(); }
    box.appendChild(chip);
  });
}

function activeColor() {
  return recipients.find((r) => r.key === activeRecipient)?.color || '#4f46e5';
}

function onPageClick(e, pageInfo) {
  if (!armedType) return;
  if (!activeRecipient) return toast('Add a signer first.');
  const spec = FIELD_TYPES.find((f) => f.type === armedType);
  const rect = pageInfo.overlay.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  // Center the new field on the click.
  let x = px - spec.w / 2, y = py - spec.h / 2;
  x = Math.max(0, Math.min(pageInfo.width - spec.w, x));
  y = Math.max(0, Math.min(pageInfo.height - spec.h, y));
  fields.push({
    key: keySeq++, recipientKey: activeRecipient, page: pageInfo.page,
    x_ratio: x / pageInfo.width, y_ratio: y / pageInfo.height,
    w_ratio: spec.w / pageInfo.width, h_ratio: spec.h / pageInfo.height,
    type: armedType, required: true,
  });
  drawFields();
}

// ---- render placed fields ------------------------------------------------

function drawFields() {
  pagesInfo.forEach((p) => (p.overlay.innerHTML = ''));
  for (const f of fields) {
    const p = pagesInfo.find((x) => x.page === f.page);
    if (!p) continue;
    const r = recipients.find((x) => x.key === f.recipientKey);
    const color = r?.color || '#4f46e5';
    const box = document.createElement('div');
    box.className = 'field-box';
    box.style.left = f.x_ratio * p.width + 'px';
    box.style.top = f.y_ratio * p.height + 'px';
    box.style.width = f.w_ratio * p.width + 'px';
    box.style.height = f.h_ratio * p.height + 'px';
    box.style.borderColor = color;
    box.style.color = color;
    box.style.background = hexToRgba(color, 0.1);
    const label = FIELD_TYPES.find((t) => t.type === f.type)?.label || f.type;
    box.innerHTML = `<span class="lbl">${label}</span>
      <button class="del" title="Remove">✕</button><span class="resize"></span>`;
    box.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); fields = fields.filter((x) => x !== f); drawFields(); };
    enableDrag(box, f, p);
    p.overlay.appendChild(box);
  }
}

function enableDrag(box, f, p) {
  const onDown = (e) => {
    if (e.target.classList.contains('del')) return;
    e.preventDefault(); e.stopPropagation();
    const resizing = e.target.classList.contains('resize');
    const startX = e.clientX, startY = e.clientY;
    const x0 = f.x_ratio * p.width, y0 = f.y_ratio * p.height;
    const w0 = f.w_ratio * p.width, h0 = f.h_ratio * p.height;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (resizing) {
        const w = Math.max(24, Math.min(p.width - x0, w0 + dx));
        const h = Math.max(18, Math.min(p.height - y0, h0 + dy));
        f.w_ratio = w / p.width; f.h_ratio = h / p.height;
        box.style.width = w + 'px'; box.style.height = h + 'px';
      } else {
        const x = Math.max(0, Math.min(p.width - w0, x0 + dx));
        const y = Math.max(0, Math.min(p.height - h0, y0 + dy));
        f.x_ratio = x / p.width; f.y_ratio = y / p.height;
        box.style.left = x + 'px'; box.style.top = y + 'px';
      }
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  box.addEventListener('mousedown', onDown);
}

// ---- save / send ---------------------------------------------------------

function validate() {
  for (const r of recipients) {
    if (!r.name.trim() || !r.email.trim()) return 'Every signer needs a name and email.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim())) return `“${r.email}” is not a valid email.`;
  }
  for (const r of recipients) {
    if (!fields.some((f) => f.recipientKey === r.key)) return `Add at least one field for ${r.name || 'each signer'}.`;
  }
  return null;
}

async function save() {
  const payload = {
    recipients: recipients.map((r, i) => ({ key: r.key, name: r.name, email: r.email, signing_order: i + 1 })),
    fields: fields.map((f) => ({
      recipientKey: f.recipientKey, page: f.page, type: f.type,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio, required: f.required,
    })),
  };
  const res = await fetch(`/api/documents/${docId}/prepare`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error); return false; }
  return true;
}

el('saveBtn').onclick = async () => {
  if (!recipients.length) return toast('Add a signer first.');
  if (await save()) toast('Draft saved.');
};

el('sendBtn').onclick = async () => {
  const err = validate();
  if (err) return toast(err);
  if (!(await save())) return;
  const res = await fetch(`/api/documents/${docId}/send`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return toast(data.error);
  el('sendResult').innerHTML =
    '<div class="banner ok" style="margin-top:12px">Sent! Share each signing link:</div><div class="linklist">' +
    data.links.map((l) => `<div><strong>${esc(l.name)}</strong> &lt;${esc(l.email)}&gt;<br><a href="${l.url}" target="_blank">${l.url}</a></div>`).join('') +
    '</div>';
  el('confirmSend').style.display = 'none';
  el('sendModal').classList.add('show');
};

el('confirmSend').style.display = 'none';
el('sendModal').querySelector('[data-close]').onclick = () => { location.href = '/'; };

// ---- utils ---------------------------------------------------------------

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escAttr(s) { return esc(s); }
function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
