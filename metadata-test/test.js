import { sniff, extractExif, readMeta, patchExif, insertExif } from '../lib/meta.js';

// Safari's canvas limit is 16,777,216 pixels (4096 x 4096). Bigger photos
// (24MP / 48MP iPhone shots) are scaled down here and flagged in the report.
const MAX_CANVAS_PIXELS = 16_777_216;

const results = document.getElementById('results');
const copyBtn = document.getElementById('copy');
const reports = [];

for (const [id, label] of [['pickA', 'A'], ['pickB', 'B']]) {
  document.getElementById(id).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) await handle(file, label);
  });
}

copyBtn.addEventListener('click', async () => {
  const text = [`Flick metadata test — ${new Date().toISOString()}`, navigator.userAgent, '', ...reports].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Copied ✓';
  } catch {
    prompt('Copy this report:', text);
  }
  setTimeout(() => (copyBtn.textContent = 'Copy report to send to Claude'), 2000);
});

async function handle(file, picker) {
  const card = el('div', 'card');
  card.append(el('h2', '', file.name || '(no name)'));
  card.append(el('div', 'file', `Picker ${picker} · ${file.type || 'unknown type'} · ${(file.size / 1e6).toFixed(2)} MB`));
  const status = el('div', 'verdict', 'Working…');
  card.append(status);
  results.prepend(card);

  const lines = [`--- Picker ${picker}: ${file.name} (${file.type || '?'}, ${file.size} bytes, lastModified ${new Date(file.lastModified).toISOString()})`];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes);
    const inTiff = extractExif(bytes);
    const inMeta = readMeta(inTiff);

    const img = await decode(file);
    const w = img.naturalWidth, h = img.naturalHeight;
    let scale = 1;
    if (w * h > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    const cw = Math.floor(w * scale), ch = Math.floor(h * scale);

    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' }) || canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) throw new Error('Browser could not encode the image (canvas too large?)');
    let out = new Uint8Array(await blob.arrayBuffer());

    let copyError = null;
    if (inTiff) {
      try { out = insertExif(out, patchExif(inTiff, { width: cw, height: ch })); }
      catch (err) { copyError = err.message; }
    }
    const outMeta = readMeta(extractExif(out));

    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    const outFile = new File([out], `${base}-flick.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });

    // verdict
    const hasLoc = (m) => m && m.lat !== undefined && m.lon !== undefined;
    let verdict, cls;
    if (!inMeta) { verdict = '✗ No metadata reached the page. The phone stripped it before Flick saw the photo.'; cls = 'bad'; }
    else if (!hasLoc(inMeta)) { verdict = '⚠ Date came through but location did not. Try the other picker or Choose File.'; cls = 'warn'; }
    else if (!hasLoc(outMeta)) { verdict = `✗ Location reached the page but was lost when saving${copyError ? `: ${copyError}` : ''}.`; cls = 'bad'; }
    else { verdict = '✓ Date and location are in the copy. Now save it and check Photos.'; cls = 'ok'; }
    status.textContent = verdict;
    status.className = `verdict ${cls}`;

    const thumb = el('img', 'thumb');
    thumb.src = URL.createObjectURL(outFile);
    status.after(thumb);

    const rows = [
      ['File type', kind, 'jpeg'],
      ['Size', `${w} × ${h}`, `${cw} × ${ch}${scale < 1 ? ' (scaled down)' : ''}`],
      ['Taken', fmtDate(inMeta), fmtDate(outMeta)],
      ['Location', fmtLoc(inMeta), fmtLoc(outMeta)],
      ['Camera', fmtCam(inMeta), fmtCam(outMeta)],
      ['Orientation', inMeta?.orientation ?? '—', outMeta?.orientation ?? '—'],
    ];
    const table = el('table');
    table.innerHTML = '<thead><tr><th></th><th>In</th><th>Out (copy)</th></tr></thead>';
    const tbody = el('tbody');
    for (const [k, a, b] of rows) {
      const tr = el('tr');
      tr.append(el('th', '', k), el('td', '', String(a)), el('td', '', String(b)));
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
    if (scale < 1) card.append(el('div', 'note', `This photo is ${(w * h / 1e6).toFixed(1)}MP, over Safari's ~16.8MP canvas limit, so the test copy is smaller. The real app will need to work around this.`));

    // actions
    const actions = el('div', 'actions');
    const canShare = navigator.canShare?.({ files: [outFile] });
    if (canShare) {
      const share = el('button', '', 'Save to Photos');
      share.onclick = async () => {
        try { await navigator.share({ files: [outFile] }); }
        catch (err) { if (err.name !== 'AbortError') alert(`Share failed: ${err.message}`); }
      };
      actions.append(share);
    }
    const dl = el('a', `btn${canShare ? ' secondary' : ''}`, 'Download');
    dl.href = thumb.src;
    dl.download = outFile.name;
    actions.append(dl);
    card.append(actions);

    lines.push(
      `kind=${kind} decoded=${w}x${h} out=${cw}x${ch}${scale < 1 ? ' SCALED' : ''} share=${canShare ? 'yes' : 'no'}`,
      `IN : ${summary(inMeta)}`,
      `OUT: ${summary(outMeta)}${copyError ? ` copyError=${copyError}` : ''}`,
      `verdict: ${verdict}`,
    );
  } catch (err) {
    status.textContent = `✗ Error: ${err.message}`;
    status.className = 'verdict bad';
    lines.push(`ERROR: ${err.message}`);
  }
  reports.push(lines.join('\n'));
  copyBtn.hidden = false;
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`This browser can't open ${file.type || 'this file type'}`));
    img.src = URL.createObjectURL(file);
  });
}

function el(tag, cls = '', text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const fmtDate = (m) => (m?.taken ? `${m.taken}${m.offset ? ` (${m.offset})` : ''}` : '—');
const fmtLoc = (m) => (m && m.lat !== undefined ? `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}` : '—');
const fmtCam = (m) => (m ? [m.make, m.model].filter(Boolean).join(' ') || '—' : '—');
const summary = (m) => (m ? `taken=${m.taken ?? '-'} offset=${m.offset ?? '-'} loc=${fmtLoc(m)} cam=${fmtCam(m)} orient=${m.orientation ?? '-'} exifBytes=${m.bytes}` : 'NO EXIF');
