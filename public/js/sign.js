import { renderPdf } from '/js/pdfview.js';
import { openSignaturePad } from '/js/sigpad.js';

const token = new URLSearchParams(location.search).get('t');
const el = (id) => document.getElementById(id);

let state = null;         // response from /api/sign/:token
let pagesInfo = [];
const values = {};        // fieldId -> value

init();

async function init() {
  const res = await fetch(`/api/sign/${token}`);
  if (!res.ok) { showMessage('warn', 'This signing link is invalid or has expired.'); return; }
  state = await res.json();
  el('docTitle').textContent = state.document.title;
  el('cTitle').textContent = state.document.title;

  if (state.alreadyComplete) {
    showMessage('ok', '✓ You have already signed this document. Thank you — no further action is needed.');
    return;
  }
  if (state.declined || state.document.status === 'voided') {
    showMessage('warn', 'This document has been voided and is no longer available for signing.');
    return;
  }
  if (state.waitingForOthers) {
    showMessage('info', 'It is not your turn yet — this document is waiting on an earlier signer. You will be able to sign once they finish.');
    return;
  }

  if (state.recipient.consented) startSigning();
  else openConsent();
}

// ---- consent -------------------------------------------------------------

function openConsent() {
  el('consentModal').classList.add('show');
  el('consentCheck').onchange = (e) => { el('consentBtn').disabled = !e.target.checked; };
  el('consentBtn').onclick = async () => {
    el('consentBtn').disabled = true;
    const res = await fetch(`/api/sign/${token}/consent`, { method: 'POST' });
    if (!res.ok) { toast('Could not record consent.'); el('consentBtn').disabled = false; return; }
    el('consentModal').classList.remove('show');
    startSigning();
  };
}

// ---- signing -------------------------------------------------------------

async function startSigning() {
  el('viewer').style.display = '';
  el('declineBtn').style.display = '';
  showMessage('info', 'Click each highlighted field to complete it, then choose <strong>Finish &amp; submit</strong>. If you can’t sign, you may <strong>Decline</strong>.');
  pagesInfo = await renderPdf(`/api/sign/${token}/file`, el('viewer'));
  drawFields();
  updateProgress();
  el('finishBtn').onclick = finish;
  wireDecline();
}

function wireDecline() {
  el('declineBtn').onclick = () => el('declineModal').classList.add('show');
  el('declineCancel').onclick = () => el('declineModal').classList.remove('show');
  el('declineConfirm').onclick = async () => {
    el('declineConfirm').disabled = true;
    const reason = el('declineReason').value.trim();
    const res = await fetch(`/api/sign/${token}/decline`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Could not decline.'); el('declineConfirm').disabled = false; return; }
    el('declineModal').classList.remove('show');
    el('viewer').style.display = 'none';
    el('declineBtn').style.display = 'none';
    el('finishBtn').style.display = 'none';
    el('progress').textContent = '';
    showMessage('warn', 'You have declined to sign this document. The sender has been notified and the document is now voided.');
  };
}

function drawFields() {
  pagesInfo.forEach((p) => (p.overlay.innerHTML = ''));
  for (const f of state.fields) {
    const p = pagesInfo.find((x) => x.page === f.page);
    if (!p) continue;
    const box = document.createElement('div');
    box.className = 'fill-field' + (f.required ? ' required' : '');
    box.style.left = f.x_ratio * p.width + 'px';
    box.style.top = f.y_ratio * p.height + 'px';
    box.style.width = f.w_ratio * p.width + 'px';
    box.style.height = f.h_ratio * p.height + 'px';
    box.dataset.field = f.id;
    renderFieldContent(box, f);
    // Option-based fields render their own interactive controls; everything
    // else is filled by clicking the box.
    if (f.type !== 'dropdown' && f.type !== 'radio') box.onclick = () => fillField(f, box);
    p.overlay.appendChild(box);
  }
}

function renderFieldContent(box, f) {
  const v = values[f.id];
  if (f.type === 'checkbox') {
    // Checkbox is always "rendered"; value 'true' shows a check, else an empty box.
    box.classList.toggle('done', v === 'true');
    box.innerHTML = `<span class="check">${v === 'true' ? '✓' : ''}</span>`;
    return;
  }
  if (f.type === 'dropdown') {
    const opts = parseOptions(f.options);
    box.classList.toggle('done', !!v);
    const sel = document.createElement('select');
    sel.className = 'field-select';
    sel.innerHTML = `<option value="">Choose…</option>` +
      opts.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = () => {
      values[f.id] = sel.value;
      box.classList.toggle('done', !!sel.value);
      updateProgress();
    };
    box.innerHTML = '';
    box.appendChild(sel);
    return;
  }
  if (f.type === 'radio') {
    const opts = parseOptions(f.options);
    box.classList.toggle('done', !!v);
    box.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'field-radio';
    opts.forEach((o) => {
      const id = `r_${f.id}_${opts.indexOf(o)}`;
      const row = document.createElement('label');
      row.className = 'radio-row';
      row.htmlFor = id;
      row.innerHTML = `<input type="radio" id="${id}" name="radio_${f.id}"${o === v ? ' checked' : ''}/><span>${esc(o)}</span>`;
      const input = row.querySelector('input');
      input.onclick = (e) => e.stopPropagation();
      input.onchange = () => {
        values[f.id] = o;
        box.classList.add('done');
        updateProgress();
      };
      list.appendChild(row);
    });
    box.appendChild(list);
    return;
  }
  if (v == null || v === '') {
    box.classList.remove('done');
    box.innerHTML = `<span>${placeholder(f.type)}</span>`;
  } else {
    box.classList.add('done');
    if (v.startsWith && v.startsWith('data:image')) box.innerHTML = `<img src="${v}" alt="signature"/>`;
    else box.innerHTML = `<span class="val">${esc(v)}</span>`;
  }
}

function placeholder(type) {
  return { signature: 'Sign', initials: 'Initials', date: 'Date', name: 'Name', text: 'Text' }[type] || 'Fill';
}

async function fillField(f, box) {
  if (f.type === 'signature' || f.type === 'initials') {
    const png = await openSignaturePad({
      title: f.type === 'initials' ? 'Adopt your initials' : 'Adopt your signature',
      name: f.type === 'initials' ? initialsOf(state.recipient.name) : state.recipient.name,
      initials: f.type === 'initials',
    });
    if (png) values[f.id] = png;
  } else if (f.type === 'date') {
    values[f.id] = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } else if (f.type === 'name') {
    values[f.id] = state.recipient.name;
  } else if (f.type === 'text') {
    const t = prompt('Enter text:', values[f.id] || '');
    if (t != null) values[f.id] = t;
  } else if (f.type === 'checkbox') {
    values[f.id] = values[f.id] === 'true' ? '' : 'true'; // toggle
  }
  renderFieldContent(box, f);
  updateProgress();
}

function updateProgress() {
  const required = state.fields.filter((f) => f.required);
  const done = required.filter((f) => values[f.id] != null && values[f.id] !== '').length;
  el('progress').textContent = `${done}/${required.length} required fields`;
  el('finishBtn').disabled = done < required.length;
}

async function finish() {
  el('finishBtn').disabled = true;
  const res = await fetch(`/api/sign/${token}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Could not submit.'); el('finishBtn').disabled = false; return; }
  el('viewer').style.display = 'none';
  el('progress').textContent = '';
  el('finishBtn').style.display = 'none';
  showMessage('ok', '✓ Signed successfully. Thank you! A completed copy with the audit certificate will be available once all signers have finished.');
}

// ---- utils ---------------------------------------------------------------

function parseOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
function initialsOf(name) {
  return (name || '').split(/\s+/).filter(Boolean).map((s) => s[0].toUpperCase()).join('');
}
function showMessage(kind, html) {
  el('message').innerHTML = `<div class="banner ${kind}">${html}</div>`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
