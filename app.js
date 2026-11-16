import { extractExif, readMeta, patchExif, insertExif } from './lib/meta.js';
import { digicam } from './lib/digicam.js';

// Safari can't make canvases over ~16.8MP. Bigger photos (24/48MP iPhone
// shots) are scaled to fit, keeping the exact aspect ratio.
const MAX_PIXELS = 16_000_000;
const OUTPUT_QUALITY = 0.92;
const PREVIEW_LONG = 900;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const $ = (id) => document.getElementById(id);
const picker = $('picker'), prints = $('prints'), hint = $('hint'), prompt = $('prompt');
const bar = $('bar'), saveAll = $('saveAll'), clearBtn = $('clear');
const stampBtn = $('stamp'), screen = $('screen'), flashbulb = $('flashbulb');

const items = [];
let queue = Promise.resolve();
let stampOn = false;

// ---------- date stamp toggle ----------

try { stampOn = localStorage.getItem('flick.stamp') === '1'; } catch {}
renderStamp();
stampBtn.addEventListener('click', () => {
  stampOn = !stampOn;
  try { localStorage.setItem('flick.stamp', stampOn ? '1' : '0'); } catch {}
  renderStamp();
  for (const item of items) enqueue(item);
});

function renderStamp() {
  stampBtn.setAttribute('aria-pressed', String(stampOn));
  const d = new Date();
  screen.textContent = stampOn ? `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}` : `'-- -- --`;
  screen.classList.toggle('on', stampOn);
}

// ---------- picking ----------

picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  if (!files.length) return;
  for (const file of files) {
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const item = { file, seed, out: null, version: 0, tilt: ((seed % 1000) / 1000 - 0.5) * 3 };
    item.el = makePrint(item);
    items.push(item);
    prints.append(item.el);
    enqueue(item);
  }
  item0Scroll();
  refresh();
  queue.then(flash);
});

clearBtn.addEventListener('click', () => {
  for (const item of items) revoke(item);
  items.length = 0;
  prints.innerHTML = '';
  refresh();
});

saveAll.addEventListener('click', () => save(items.filter((i) => i.out).map((i) => i.out.file)));

function item0Scroll() {
  const first = prints.firstElementChild;
  if (first && items.length <= 6) first.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}

// ---------- developing ----------

function enqueue(item) {
  const version = ++item.version;
  if (!item.out) setDeveloping(item);
  queue = queue.then(() => develop(item, version)).catch(() => {});
}

async function develop(item, version) {
  if (!items.includes(item) || version !== item.version) return;
  try {
    if (!item.prepared) item.prepared = await prepare(item.file);
    const { img, w, h, tiff, date } = item.prepared;

    const canvas = await digicam(img, { width: w, height: h, seed: item.seed, dateStamp: stampOn ? date : null });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', OUTPUT_QUALITY));
    if (!blob) throw new Error('this phone ran out of memory for this photo');
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (tiff) { try { bytes = insertExif(bytes, patchExif(tiff, { width: w, height: h })); } catch {} }

    const preview = await previewUrl(canvas);
    canvas.width = canvas.height = 0; // free memory on iOS
    if (version !== item.version || !items.includes(item)) { URL.revokeObjectURL(preview); return; }

    const name = `${(item.file.name || 'photo').replace(/\.[^.]+$/, '')}-flick.jpg`;
    if (item.out) URL.revokeObjectURL(item.out.preview);
    item.out = { file: new File([bytes], name, { type: 'image/jpeg', lastModified: item.file.lastModified }), preview };
    showPrint(item);
  } catch (err) {
    showError(item, err.message);
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
  try { await img.decode(); } catch { throw new Error(`can't open ${file.type || 'this kind of file'}. try a jpeg or heic photo`); }

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

// ---------- prints ----------

function makePrint(item) {
  const print = el('figure', 'print');
  print.style.setProperty('--tilt', `${item.tilt.toFixed(2)}deg`);
  print.style.margin = '0';
  return print;
}

function setDeveloping(item) {
  item.el.innerHTML = '';
  const photo = el('div', 'photo');
  photo.append(el('div', 'developing', 'developing…'));
  const caption = el('figcaption', 'caption');
  caption.append(el('span', 'date', ' '));
  item.el.append(photo, caption);
}

function showPrint(item) {
  const print = item.el;
  print.innerHTML = '';
  print.classList.remove('showing-original');

  const photo = el('div', 'photo');
  const img = el('img');
  img.src = item.out.preview;
  img.alt = `filtered ${item.file.name || 'photo'}`;
  img.draggable = false;
  photo.append(img);

  const caption = el('figcaption', 'caption');
  const d = item.prepared.date;
  const date = el('span', 'date', `${MONTHS[d.getMonth()]} ${d.getDate()} '${pad(d.getFullYear() % 100)}`);
  const orig = el('span', 'original', 'the original');
  const btn = el('button', 'save', 'save');
  btn.type = 'button';
  btn.addEventListener('click', () => save([item.out.file]));
  caption.append(date, orig, btn);

  // press and hold to compare with the original
  const show = (on) => {
    img.src = on ? item.prepared.url : item.out.preview;
    print.classList.toggle('showing-original', on);
  };
  img.addEventListener('pointerdown', () => show(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) img.addEventListener(ev, () => show(false));
  img.addEventListener('contextmenu', (e) => e.preventDefault());

  print.append(photo, caption);
}

function showError(item, message) {
  item.el.innerHTML = '';
  item.el.append(el('div', 'err', `couldn't develop this one: ${message}`));
}

function refresh() {
  const n = items.length, ready = items.filter((i) => i.out).length;
  hint.hidden = ready === 0;
  bar.hidden = n === 0;
  prompt.textContent = n ? 'tap the camera to add more' : 'tap the camera to pick photos';
  saveAll.disabled = ready < n;
  saveAll.innerHTML = '';
  if (ready < n) saveAll.textContent = `developing ${ready}/${n}`;
  else if (n === 1) saveAll.textContent = 'save photo';
  else { saveAll.append('save '); saveAll.append(el('b', '', `all ${n}`)); }
}

function flash() {
  if (!items.some((i) => i.out)) return;
  flashbulb.classList.remove('go');
  void flashbulb.offsetWidth;
  flashbulb.classList.add('go');
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
