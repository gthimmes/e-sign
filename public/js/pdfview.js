// Thin wrapper around pdf.js: render every page of a PDF into a container,
// each page wrapped in a positioned <div> with an .overlay for field markup.
import * as pdfjsLib from '/vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

// Returns [{ page, wrap, overlay, width, height }] where width/height are the
// rendered pixel dimensions (used to convert ratios <-> pixels).
export async function renderPdf(url, container, { scale = 1.35 } = {}) {
  container.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    wrap.dataset.page = n;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.page = n;

    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    container.appendChild(wrap);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    out.push({ page: n, wrap, overlay, width: viewport.width, height: viewport.height });
  }
  return out;
}
