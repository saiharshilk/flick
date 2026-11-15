// Flick metadata helpers.
// Reads the EXIF block (date, GPS, camera) out of JPEG or HEIC files and
// writes it into a newly encoded JPEG, so filtered copies keep their metadata.
// No dependencies.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// ---------- file type ----------

export function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif)$/.test(brand)) return 'heic';
    return 'isobmff';
  }
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png';
  return 'unknown';
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------- EXIF extraction ----------

// Returns the raw TIFF block (starts with "II*\0" or "MM\0*") or null.
export function extractExif(bytes) {
  const kind = sniff(bytes);
  if (kind === 'jpeg') return jpegExif(bytes);
  if (kind === 'heic' || kind === 'isobmff') return heicExif(bytes);
  return null;
}

function jpegSegments(bytes) {
  // Returns header segments up to (not including) SOS, plus where SOS starts.
  const segs = [];
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) break;
    let marker = bytes[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    segs.push({ marker, start: p, end: p + 2 + len });
    p += 2 + len;
  }
  return { segs, bodyStart: p };
}

function isExifSeg(bytes, seg) {
  return seg.marker === 0xe1 && ascii(bytes, seg.start + 4, 4) === 'Exif' &&
    bytes[seg.start + 8] === 0 && bytes[seg.start + 9] === 0;
}

function jpegExif(bytes) {
  const { segs } = jpegSegments(bytes);
  const seg = segs.find((s) => isExifSeg(bytes, s));
  return seg ? bytes.slice(seg.start + 10, seg.end) : null;
}

// HEIC: find the item of type 'Exif' via meta/iinf + meta/iloc.
function heicExif(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = findBox(bytes, dv, 0, bytes.length, 'meta');
  if (!meta) return null;
  const inner = meta.payload + 4; // full box: version + flags
  const iinf = findBox(bytes, dv, inner, meta.end, 'iinf');
  const iloc = findBox(bytes, dv, inner, meta.end, 'iloc');
  if (!iinf || !iloc) return null;

  // iinf -> item id of type Exif
  const iinfVer = bytes[iinf.payload];
  let p = iinf.payload + 4 + (iinfVer === 0 ? 2 : 4);
  let exifId = null;
  while (p + 8 <= iinf.end) {
    const box = readBoxHeader(bytes, dv, p, iinf.end);
    if (!box) break;
    if (box.type === 'infe') {
      const v = bytes[box.payload];
      if (v >= 2) {
        let q = box.payload + 4;
        const id = v === 2 ? dv.getUint16(q) : dv.getUint32(q);
        q += v === 2 ? 2 : 4;
        q += 2; // protection index
        if (ascii(bytes, q, 4) === 'Exif') { exifId = id; break; }
      }
    }
    p = box.end;
  }
  if (exifId === null) return null;

  // iloc -> extents for that item
  const v = bytes[iloc.payload];
  let q = iloc.payload + 4;
  const offSize = bytes[q] >> 4, lenSize = bytes[q] & 15;
  const baseSize = bytes[q + 1] >> 4, idxSize = v >= 1 ? bytes[q + 1] & 15 : 0;
  q += 2;
  const readN = (n) => {
    let val = 0;
    for (let i = 0; i < n; i++) val = val * 256 + bytes[q + i];
    q += n;
    return val;
  };
  const count = v < 2 ? readN(2) : readN(4);
  for (let i = 0; i < count; i++) {
    const id = v < 2 ? readN(2) : readN(4);
    const method = v >= 1 ? readN(2) & 15 : 0;
    readN(2); // data reference index
    const base = readN(baseSize);
    const extents = readN(2);
    const parts = [];
    for (let e = 0; e < extents; e++) {
      if (v >= 1 && idxSize > 0) readN(idxSize);
      const off = readN(offSize), len = readN(lenSize);
      parts.push([base + off, len]);
    }
    if (id !== exifId) continue;
    if (method !== 0) return null; // data stored inside idat; not used by iPhones
    const total = parts.reduce((s, [, l]) => s + l, 0);
    const data = new Uint8Array(total);
    let w = 0;
    for (const [o, l] of parts) { data.set(bytes.subarray(o, o + l), w); w += l; }
    const skip = new DataView(data.buffer).getUint32(0);
    let start = 4 + skip;
    if (!isTiffHeader(data, start)) start = findTiffHeader(data);
    return start >= 0 ? data.slice(start) : null;
  }
  return null;
}

function readBoxHeader(bytes, dv, p, limit) {
  if (p + 8 > limit) return null;
  let size = dv.getUint32(p);
  const type = ascii(bytes, p + 4, 4);
  let header = 8;
  if (size === 1) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
  else if (size === 0) size = limit - p;
  if (size < header || p + size > limit) return null;
  return { type, start: p, payload: p + header, end: p + size };
}

function findBox(bytes, dv, start, end, type) {
  let p = start;
  while (p < end) {
    const box = readBoxHeader(bytes, dv, p, end);
    if (!box) return null;
    if (box.type === type) return box;
    p = box.end;
  }
  return null;
}

function isTiffHeader(b, i) {
  return (b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) ||
    (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a);
}

function findTiffHeader(b) {
  for (let i = 0; i < Math.min(b.length - 4, 64); i++) if (isTiffHeader(b, i)) return i;
  return -1;
}

// ---------- TIFF reading ----------

function tiff(t) {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const i32 = (o) => dv.getInt32(o, le);

  function ifd(off) {
    const entries = new Map();
    if (!off || off + 2 > t.length) return { entries, nextPtrPos: null };
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const data = size <= 4 ? e + 8 : u32(e + 8);
      entries.set(u16(e), { type, count, data, entry: e });
    }
    return { entries, nextPtrPos: off + 2 + n * 12 };
  }

  function value(ent) {
    if (!ent || ent.data + (TYPE_SIZE[ent.type] || 1) * ent.count > t.length) return undefined;
    const { type, count, data } = ent;
    if (type === 2) return ascii(t, data, count).replace(/\0+$/, '');
    const out = [];
    for (let i = 0; i < count; i++) {
      if (type === 3) out.push(u16(data + i * 2));
      else if (type === 4) out.push(u32(data + i * 4));
      else if (type === 9) out.push(i32(data + i * 4));
      else if (type === 5) out.push(u32(data + i * 8) / (u32(data + i * 8 + 4) || 1));
      else if (type === 10) out.push(i32(data + i * 8) / (i32(data + i * 8 + 4) || 1));
      else out.push(t[data + i]);
    }
    return count === 1 ? out[0] : out;
  }

  return { dv, le, u32, ifd, value, ifd0: u32(4) };
}

// Human-readable summary of the metadata that matters for Flick.
export function readMeta(t) {
  if (!t) return null;
  const T = tiff(t);
  const ifd0 = T.ifd(T.ifd0).entries;
  const exif = T.ifd(T.value(ifd0.get(0x8769))).entries;
  const gps = T.ifd(T.value(ifd0.get(0x8825))).entries;

  const dms = (v, ref) => {
    if (!Array.isArray(v)) return undefined;
    const d = v[0] + v[1] / 60 + v[2] / 3600;
    return ref === 'S' || ref === 'W' ? -d : d;
  };
  const lat = dms(T.value(gps.get(2)), T.value(gps.get(1)));
  const lon = dms(T.value(gps.get(4)), T.value(gps.get(3)));

  return {
    make: T.value(ifd0.get(0x010f)),
    model: T.value(ifd0.get(0x0110)),
    orientation: T.value(ifd0.get(0x0112)),
    taken: T.value(exif.get(0x9003)) || T.value(ifd0.get(0x0132)),
    offset: T.value(exif.get(0x9011)),
    lens: T.value(exif.get(0xa434)),
    width: T.value(exif.get(0xa002)),
    height: T.value(exif.get(0xa003)),
    lat, lon,
    altitude: T.value(gps.get(6)),
    bytes: t.length,
  };
}

// ---------- writing ----------

// Copy of the TIFF block fixed up for a new upright image:
// orientation = 1 (pixels are already rotated), pixel size = new size,
// and the old embedded thumbnail (IFD1) is unlinked.
export function patchExif(t, { width, height }) {
  const out = t.slice();
  const T = tiff(out);
  const set = (ent, val) => {
    if (!ent) return;
    if (ent.type === 3 && ent.count === 1) T.dv.setUint16(ent.data, val, T.le);
    else if (ent.type === 4 && ent.count === 1) T.dv.setUint32(ent.data, val, T.le);
  };
  const ifd0 = T.ifd(T.ifd0);
  set(ifd0.entries.get(0x0112), 1);
  if (ifd0.nextPtrPos !== null && ifd0.nextPtrPos + 4 <= out.length) T.dv.setUint32(ifd0.nextPtrPos, 0, T.le);
  const exifPtr = T.value(ifd0.entries.get(0x8769));
  if (exifPtr) {
    const exif = T.ifd(exifPtr).entries;
    set(exif.get(0xa002), width);
    set(exif.get(0xa003), height);
  }
  return out;
}

// Put a TIFF block into a JPEG as its APP1 Exif segment (replacing any existing one).
export function insertExif(jpeg, t) {
  const segLen = 2 + 6 + t.length;
  if (segLen > 0xffff) throw new Error(`EXIF block too big for JPEG (${t.length} bytes)`);
  const { segs, bodyStart } = jpegSegments(jpeg);
  const keep = segs.filter((s) => !isExifSeg(jpeg, s));
  const app1 = new Uint8Array(2 + segLen);
  app1.set([0xff, 0xe1, segLen >> 8, segLen & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  app1.set(t, 10);
  const parts = [jpeg.subarray(0, 2), app1, ...keep.map((s) => jpeg.subarray(s.start, s.end)), jpeg.subarray(bodyStart)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  return out;
}
