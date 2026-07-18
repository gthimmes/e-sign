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
  { type: 'checkbox', label: 'Checkbox', w: 26, h: 26 },
  { type: 'dropdown', label: 'Dropdown', w: 165, h: 30, options: true },
  { type: 'radio', label: 'Radio group', w: 165, h: 92, options: true },
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
    recipients.push({ key, name: r.name, email: r.email, color: COLORS[i % COLORS.length], hasCode: !!r.has_access_code });
  });
  data.fields.forEach((f) => {
    fields.push({
      key: keySeq++, recipientKey: keyById[f.recipient_id], page: f.page,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
      type: f.type, required: !!f.required, options: parseOptions(f.options),
    });
  });
  if (!recipients.length) addRecipient();
  activeRecipient = recipients[0].key;

  renderRecipients();
  renderTools();
  loadTemplates();

  pagesInfo = await renderPdf(`/api/documents/${docId}/file`, el('viewer'));
  pagesInfo.forEach((p) => {
    p.overlay.addEventListener('click', (e) => onPageClick(e, p));
  });
  drawFields();
}

// ---- templates -----------------------------------------------------------

async function loadTemplates() {
  const res = await fetch('/api/templates');
  if (!res.ok) return;
  const { templates } = await res.json();
  const box = el('templateList');
  if (!templates.length) { box.innerHTML = '<span class="muted">No templates yet — lay out fields, then save.</span>'; return; }
  box.innerHTML = '';
  templates.forEach((t) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px';
    row.innerHTML = `<span style="flex:1"><strong>${esc(t.name)}</strong>
        <span class="muted">· ${t.fields.length} field(s), ${Math.max(...t.fields.map((f) => f.role))} signer(s)</span></span>
      <button class="btn sm" data-apply="${t.id}">Apply</button>
      <button class="btn sm danger" data-tdel="${t.id}" title="Delete template">✕</button>`;
    row.querySelector('[data-apply]').onclick = () => applyTemplate(t);
    row.querySelector('[data-tdel]').onclick = async () => {
      if (!confirm(`Delete template “${t.name}”?`)) return;
      await fetch(`/api/templates/${t.id}`, { method: 'DELETE' });
      loadTemplates();
    };
    box.appendChild(row);
  });
}

el('saveTemplate').onclick = async () => {
  if (!fields.length) return toast('Place some fields first, then save them as a template.');
  const name = prompt('Template name:', '');
  if (name == null || !name.trim()) return;
  // Map each field's recipient to its 1-based signer position (role).
  const roleOf = Object.fromEntries(recipients.map((r, i) => [r.key, i + 1]));
  const payload = {
    name: name.trim(),
    fields: fields.map((f) => ({
      role: roleOf[f.recipientKey] || 1, page: f.page, type: f.type,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
      required: f.required, options: f.options || [],
    })),
  };
  const res = await fetch('/api/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || 'Could not save template.');
  toast(`Template “${data.template.name}” saved.`);
  loadTemplates();
};

function applyTemplate(t) {
  const maxRole = Math.max(...t.fields.map((f) => f.role));
  while (recipients.length < maxRole) addRecipient();
  const pageCount = pagesInfo.length;
  let skipped = 0;
  for (const f of t.fields) {
    if (f.page > pageCount) { skipped++; continue; }
    fields.push({
      key: keySeq++, recipientKey: recipients[f.role - 1].key, page: f.page,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
      type: f.type, required: f.required !== false, options: f.options || [],
    });
  }
  renderRecipients();
  drawFields();
  toast(skipped
    ? `Template applied — ${skipped} field(s) skipped (this document has fewer pages).`
    : `Template “${t.name}” applied.`);
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
      <input type="email" placeholder="Email address" data-f="email" data-k="${r.key}" value="${escAttr(r.email)}" style="margin-top:6px"/>
      <input type="text" autocomplete="off" data-f="access_code" data-k="${r.key}" style="margin-top:6px"
        placeholder="${r.hasCode ? '🔒 Access code set — type to replace' : 'Access code (optional)'}" value="${escAttr(r.access_code || '')}"/>`;
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
  // Option-based fields (dropdown/radio) need their choices up front.
  let options = [];
  if (spec.options) {
    options = promptOptions([]);
    if (!options) return; // cancelled — don't place
  }
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
    type: armedType, required: true, options,
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
    const base = FIELD_TYPES.find((t) => t.type === f.type)?.label || f.type;
    const isOpt = f.type === 'dropdown' || f.type === 'radio';
    const label = isOpt ? `${base} (${(f.options || []).length}) ✎` : base;
    box.innerHTML = `<span class="lbl">${esc(label)}</span>
      <button class="del" title="Remove">✕</button><span class="resize"></span>`;
    box.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); fields = fields.filter((x) => x !== f); drawFields(); };
    if (isOpt) {
      box.title = 'Double-click to edit options';
      box.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        const next = promptOptions(f.options || []);
        if (next) { f.options = next; drawFields(); }
      });
    }
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
    if (r.access_code && (r.access_code.length < 4 || r.access_code.length > 64)) {
      return 'Access codes must be 4–64 characters.';
    }
  }
  for (const r of recipients) {
    if (!fields.some((f) => f.recipientKey === r.key)) return `Add at least one field for ${r.name || 'each signer'}.`;
  }
  for (const f of fields) {
    if ((f.type === 'dropdown' || f.type === 'radio') && (f.options || []).length < 2) {
      return 'Dropdown and radio fields need at least two options (double-click the field to edit).';
    }
  }
  return null;
}

async function save() {
  const payload = {
    recipients: recipients.map((r, i) => ({
      key: r.key, name: r.name, email: r.email, signing_order: i + 1,
      // access_code sets/replaces; keep_code preserves an already-stored code.
      access_code: r.access_code || undefined,
      keep_code: !r.access_code && r.hasCode ? true : undefined,
    })),
    fields: fields.map((f) => ({
      recipientKey: f.recipientKey, page: f.page, type: f.type,
      x_ratio: f.x_ratio, y_ratio: f.y_ratio, w_ratio: f.w_ratio, h_ratio: f.h_ratio,
      required: f.required, options: f.options || [],
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

// Prompt for a comma/newline-separated option list; returns a cleaned array,
// or null if the user cancels.
function promptOptions(existing) {
  const raw = prompt('Enter the choices, separated by commas:', (existing || []).join(', '));
  if (raw == null) return null;
  const clean = [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 30);
  return clean;
}
function parseOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
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
