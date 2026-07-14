// A self-contained signature capture modal. Resolves to a trimmed PNG data URL
// (drawn or typed) or null if cancelled. Used for signature + initials fields.
export function openSignaturePad({ title = 'Adopt your signature', name = '', initials = false } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg show';
    bg.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="body">
          <h2 style="margin-bottom:6px">${title}</h2>
          <p class="muted" style="margin:0 0 14px">Your signature is legally binding. Draw it or type your name.</p>
          <div class="sigpad-tabs">
            <button class="btn sm active" data-tab="draw">Draw</button>
            <button class="btn sm" data-tab="type">Type</button>
          </div>
          <div data-panel="draw">
            <canvas class="sigpad"></canvas>
          </div>
          <div data-panel="type" style="display:none">
            <input type="text" class="type-input" placeholder="Type your ${initials ? 'initials' : 'name'}" value="${escapeHtml(name)}"/>
            <div class="typed-preview" data-preview></div>
          </div>
        </div>
        <div class="foot">
          <button class="btn ghost" data-act="clear">Clear</button>
          <div class="spacer" style="flex:1"></div>
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <button class="btn primary" data-act="apply">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(bg);

    const canvas = bg.querySelector('.sigpad');
    const typeInput = bg.querySelector('.type-input');
    const preview = bg.querySelector('[data-preview]');
    let mode = 'draw';

    // Size the canvas backing store to its displayed size for crisp strokes.
    const ctx = canvas.getContext('2d');
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0b1f45';
    };
    requestAnimationFrame(fit);

    let drawing = false, hasInk = false, last = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };
    const start = (e) => { e.preventDefault(); drawing = true; last = pos(e); };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; hasInk = true;
    };
    const end = () => { drawing = false; };
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    const renderPreview = () => { preview.textContent = typeInput.value || 'Your name'; };
    typeInput.addEventListener('input', renderPreview);
    renderPreview();

    bg.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.tab;
        bg.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        bg.querySelector('[data-panel="draw"]').style.display = mode === 'draw' ? '' : 'none';
        bg.querySelector('[data-panel="type"]').style.display = mode === 'type' ? '' : 'none';
      })
    );

    const close = (val) => { bg.remove(); resolve(val); };
    bg.querySelector('[data-act="cancel"]').onclick = () => close(null);
    bg.querySelector('[data-act="clear"]').onclick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false;
      typeInput.value = ''; renderPreview();
    };
    bg.querySelector('[data-act="apply"]').onclick = () => {
      if (mode === 'draw') {
        if (!hasInk) return flash(bg, 'Please draw your signature.');
        close(trimCanvas(canvas));
      } else {
        const t = typeInput.value.trim();
        if (!t) return flash(bg, 'Please type your name.');
        close(typedToPng(t));
      }
    };
  });
}

// Render typed text to a transparent PNG using a script-style font.
function typedToPng(text) {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#0b1f45';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  let size = 90;
  g.font = `${size}px "Segoe Script","Brush Script MT",cursive`;
  while (g.measureText(text).width > 560 && size > 24) {
    size -= 4; g.font = `${size}px "Segoe Script","Brush Script MT",cursive`;
  }
  g.fillText(text, 300, 105);
  return trimCanvas(c);
}

// Crop transparent margins so the stamped image fits its box tightly.
function trimCanvas(canvas) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const data = g.getImageData(0, 0, w, h).data;
  let top = h, left = w, right = 0, bottom = 0, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        found = true;
        if (x < left) left = x; if (x > right) right = x;
        if (y < top) top = y; if (y > bottom) bottom = y;
      }
    }
  }
  if (!found) return canvas.toDataURL('image/png');
  const pad = 6;
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(w, right + pad); bottom = Math.min(h, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left; out.height = bottom - top;
  out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function flash(bg, msg) {
  let el = bg.querySelector('.pad-err');
  if (!el) {
    el = document.createElement('div');
    el.className = 'pad-err muted';
    el.style.cssText = 'color:#dc2626;font-size:12px;margin-top:8px';
    bg.querySelector('.body').appendChild(el);
  }
  el.textContent = msg;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
