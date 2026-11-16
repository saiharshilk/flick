import { extractExif, readMeta, patchExif, insertExif } from './lib/meta.js';
import { digicam } from './lib/digicam.js';

// Safari can't make canvases over ~16.8MP. Bigger photos (24/48MP iPhone
// shots) are scaled to fit, keeping the exact aspect ratio.
const MAX_PIXELS = 16_000_000;
const OUTPUT_QUALITY = 0.92;
const PREVIEW_LONG = 900;

const $ = (id) => document.getElementById(id);
const picker = $('picker'), grid = $('grid'), empty = $('empty'), hint = $('hint');
const bar = $('bar'), saveAll = $('saveAll'), clearBtn = $('clear'), stampToggle = $('stamp');

const items = [];
let queue = Promise.resolve();

// little orange "date stamp" in the header
const now = new Date();
$('today').textContent = `'${String(now.getFullYear() % 100).padStart(2, '0')} ${pad(now.getMonth() + 1)} ${pad(now.getDate())}`;

try { stampToggle.checked = localStorage.getItem('flick.stamp') === '1'; } catch {}
stampToggle.addEventListener('change', () => {
  try { localStorage.setItem('flick.stamp', stampToggle.checked ? '1' : '0'); } catch {}
  for (const item of items) enqueue(item);
});

picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  for (const file of files) {
    const item = { file, seed: (Math.random() * 2 ** 32) >>> 0, out: null, version: 0 };
    item.tile = makeTile(item);
    items.push(item);
    grid.append(item.tile);
    enqueue(item);
  }
  refresh();
});

clearBtn.addEventListener('click', () => {
  for (const item of items) revoke(item);
  items.length = 0;
  grid.innerHTML = '';
  refresh();
});

saveAll.addEventListener('click', () => save(items.filter((i) => i.out).map((i) => i.out.file)));

function enqueue(item) {
  const version = ++item.version;
  setBusy(item, 'Developing…');
  queue = queue.then(() => process(item, version)).catch(() => {});
}

async function process(item, version) {
  if (!items.includes(item) || version !== item.version) return;
  try {
    if (!item.prepared) item.prepared = await prepare(item.file);
    const { img, w, h, tiff, date } = item.prepared;

    const canvas = await digicam(img, {
      width: w, height: h, seed: item.seed,
      dateStamp: stampToggle.checked ? date : null,
    });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', OUTPUT_QUALITY));
    if (!blob) throw new Error('Could not save this photo');
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (tiff) { try { bytes = insertExif(bytes, patchExif(tiff, { width: w, height: h })); } catch {} }

    const preview = await previewUrl(canvas);
    canvas.width = canvas.height = 0; // free memory on iOS
    if (version !== item.version || !items.includes(item)) { URL.revokeObjectURL(preview); return; }

    const name = `${(item.file.name || 'photo').replace(/\.[^.]+$/, '')}-flick.jpg`;
    if (item.out) URL.revokeObjectURL(item.out.preview);
    item.out = { file: new File([bytes], name, { type: 'image/jpeg', lastModified: item.file.lastModified }), preview };
    showResult(item);
  } catch (err) {
    item.tile.innerHTML = '';
    item.tile.append(el('div', 'err', `Couldn't process this photo: ${err.message}`));
  }
  refresh();
}

async function prepare(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let tiff = null, meta = null;
  try { tiff = extractExif(bytes); meta = readMeta(tiff); } catch {}

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { throw new Error(`this browser can't open ${file.type || 'this file'}`); }

  let w = img.naturalWidth, h = img.naturalHeight;
  if (w * h > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.round(w * s); h = Math.round(h * s);
  }
  return { img, url, w, h, tiff, date: parseExifDate(meta?.taken) || new Date(file.lastModified || Date.now()) };
}

async function previewUrl(canvas) {
  const s = Math.min(1, PREVIEW_LONG / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return URL.createObjectURL(blob);
}

// ---------- tiles ----------

function makeTile(item) {
  const tile = el('div', 'tile');
  tile.append(el('div', 'busy', 'Developing…'));
  return tile;
}

function setBusy(item, text) {
  if (item.out) return; // keep showing the old result while re-developing
  item.tile.innerHTML = '';
  item.tile.append(el('div', 'busy', text));
}

function showResult(item) {
  const tile = item.tile;
  tile.innerHTML = '';
  tile.classList.remove('showing-original');
  const img = el('img');
  img.src = item.out.preview;
  img.alt = item.file.name || 'filtered photo';
  img.draggable = false;
  const badge = el('span', 'badge', 'Original');
  const btn = el('button', 'save', 'Save');
  btn.addEventListener('click', (e) => { e.stopPropagation(); save([item.out.file]); });

  // press and hold to compare with the original
  const show = (on) => {
    if (!item.prepared) return;
    img.src = on ? item.prepared.url : item.out.preview;
    tile.classList.toggle('showing-original', on);
  };
  img.addEventListener('pointerdown', () => show(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) img.addEventListener(ev, () => show(false));
  img.addEventListener('contextmenu', (e) => e.preventDefault());

  tile.append(img, badge, btn);
}

function refresh() {
  const n = items.length, ready = items.filter((i) => i.out).length;
  empty.hidden = n > 0;
  hint.hidden = ready === 0;
  bar.hidden = n === 0;
  saveAll.disabled = ready === 0;
  saveAll.textContent = ready < n ? `Developing ${ready}/${n}…` : n === 1 ? 'Save photo' : `Save all ${n}`;
}

// ---------- saving ----------

async function save(files) {
  if (!files.length) return;
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  for (const f of files) {
    const a = el('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
}

// ---------- utils ----------

function revoke(item) {
  item.version++;
  if (item.out) URL.revokeObjectURL(item.out.preview);
  if (item.prepared) URL.revokeObjectURL(item.prepared.url);
}

function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function pad(n) { return String(n).padStart(2, '0'); }

function el(tag, cls = '', text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
