// Digicam filter: the early-2000s point-and-shoot / CCD look.
//
// The trick is to "shoot" the photo on a small virtual sensor (~2MP),
// do all the grading there, then scale back up to the original size.
// That gives the soft detail, clumpy noise and blooming highlights for free,
// and keeps it fast on a phone.

export const DIGICAM = {
  sensorLong: 1500,     // long side of the virtual sensor, in pixels
  lensSoft: 0.7,        // optical softness (0 = sharp, 1 = soft)
  // white balance (multipliers)
  wbR: 1.03, wbG: 0.99, wbB: 0.965,
  // levels: crushed blacks, early highlight clipping
  blackPoint: 0.04, whitePoint: 0.92,
  contrast: 0.32,       // S-curve strength
  satBase: 0.94,        // overall saturation
  satVivid: 0.55,       // extra saturation for already-vivid colors
  // split toning
  shadowTint: [0.06, -0.012, 0.028],   // warm magenta in the shadows
  highlightTint: [0.012, -0.006, 0.006], // warm-pink whites
  bloomThreshold: 0.62, bloomAmount: 0.75,
  sharpen: 0.6,         // cheap in-camera sharpening (halos)
  vignette: 0.16,
  noiseLuma: 0.068, noiseChroma: 0.042,
  jpegQuality: 0.62,    // in-camera compression artifacts
};

/**
 * @param {CanvasImageSource} source  decoded, upright image
 * @param {object} opts
 * @param {number} opts.width   output width
 * @param {number} opts.height  output height
 * @param {Date|null} opts.dateStamp  draw an orange date stamp if set
 * @param {number} opts.seed    randomness seed (noise + small per-photo variation)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function digicam(source, { width, height, dateStamp = null, seed = Date.now() }) {
  const P = DIGICAM;
  const rand = mulberry32(seed >>> 0);
  const jitter = (amt) => 1 + (rand() * 2 - 1) * amt;

  // 1. Capture on the small sensor.
  const s = Math.min(1, P.sensorLong / Math.max(width, height));
  const sw = Math.max(1, Math.round(width * s)), sh = Math.max(1, Math.round(height * s));
  const sensor = stepDown(source, width, height, sw, sh);
  const sctx = sensor.getContext('2d', { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, sw, sh);
  const px = img.data;
  const n = sw * sh;
  const buf = new Float32Array(n * 3);

  // 2. Tone + color.
  const warm = jitter(0.012), bloomK = P.bloomAmount * jitter(0.15);
  const bp = P.blackPoint, range = P.whitePoint - P.blackPoint, C = P.contrast;
  const [sr, sg, sb] = P.shadowTint, [hr, hg, hb] = P.highlightTint;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = (px[j] / 255) * P.wbR * warm, g = (px[j + 1] / 255) * P.wbG, b = (px[j + 2] / 255) * P.wbB / warm;
    r = curve((r - bp) / range, C); g = curve((g - bp) / range, C); b = curve((b - bp) / range, C);
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const k = P.satBase + P.satVivid * sat;
    r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
    const ws = 4 * L * (1 - L) * (1 - L);            // peaks in the shadows, zero at pure black
    const t = clamp01((L - 0.6) / 0.4), wh = t * t * (3 - 2 * t);
    buf[i * 3] = r + sr * ws + hr * wh;
    buf[i * 3 + 1] = g + sg * ws + hg * wh;
    buf[i * 3 + 2] = b + sb * ws + hb * wh;
  }

  // 3. Bloom: blur the brightest parts and screen them back on.
  const hi = new ImageData(sw, sh);
  const thr = P.bloomThreshold, span = 1 - thr;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    let m = (Math.max(r, g, b) - thr) / span;
    m = m > 0 ? Math.min(1, m) ** 2 : 0;
    hi.data[j] = to255(r * m * 1.05); hi.data[j + 1] = to255(g * m * 0.95); hi.data[j + 2] = to255(b * m); hi.data[j + 3] = 255;
  }
  const wide = blur(hi, 16), tight = blur(hi, 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    for (let c = 0; c < 3; c++) {
      const bl = (wide.data[j + c] * 0.7 + tight.data[j + c] * 0.9) / 255 * bloomK;
      const v = buf[i * 3 + c];
      buf[i * 3 + c] = 1 - (1 - v) * (1 - Math.min(1, bl));
    }
  }

  // 4. Cheap plastic lens (softness), then in-camera sharpening on top of it,
  //    which brings back edge halos but not real detail.
  const base = new ImageData(sw, sh);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    base.data[j] = to255(buf[i * 3]); base.data[j + 1] = to255(buf[i * 3 + 1]); base.data[j + 2] = to255(buf[i * 3 + 2]); base.data[j + 3] = 255;
  }
  const lens = blur(base, 2);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    for (let c = 0; c < 3; c++) buf[i * 3 + c] += (lens.data[j + c] / 255 - buf[i * 3 + c]) * P.lensSoft;
    for (let c = 0; c < 3; c++) lens.data[j + c] = to255(buf[i * 3 + c]);
  }
  const soft = blur(lens, 4);

  // 5. Sharpen + vignette + sensor noise, write back.
  const cx = sw / 2, cy = sh / 2, maxR2 = cx * cx + cy * cy;
  for (let y = 0, i = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++, i++) {
      const j = i * 4;
      const dx = x - cx, dy = y - cy;
      const vig = 1 - P.vignette * ((dx * dx + dy * dy) / maxR2);
      let r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
      r += P.sharpen * (r - soft.data[j] / 255);
      g += P.sharpen * (g - soft.data[j + 1] / 255);
      b += P.sharpen * (b - soft.data[j + 2] / 255);
      r *= vig; g *= vig; b *= vig;
      const L = clamp01(0.299 * r + 0.587 * g + 0.114 * b);
      const dark = (1 - L) ** 1.5;
      const amp = 0.55 + 0.45 * dark;
      const nl = gauss(rand) * P.noiseLuma * amp;
      const ca = P.noiseChroma * dark;
      px[j] = to255(r + nl + gauss(rand) * ca);
      px[j + 1] = to255(g + nl + gauss(rand) * ca * 0.8);
      px[j + 2] = to255(b + nl + gauss(rand) * ca * 1.2);
    }
  }
  sctx.putImageData(img, 0, 0);

  // 6. Date stamp (drawn on the sensor so it gets the same softness).
  if (dateStamp) drawDateStamp(sctx, sw, sh, dateStamp);

  // 7. In-camera JPEG compression.
  const jpeg = await new Promise((r) => sensor.toBlob(r, 'image/jpeg', P.jpegQuality));
  if (jpeg) {
    const bmp = await loadBlob(jpeg);
    sctx.drawImage(bmp, 0, 0, sw, sh);
    bmp.close?.();
  }

  // 8. Back up to the original size.
  const out = makeCanvas(width, height);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(sensor, 0, 0, width, height);
  return out;
}

// ---------- helpers ----------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// High-quality downscale by halving repeatedly.
function stepDown(src, w, h, tw, th) {
  let cur = src, cw = w, ch = h;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = makeCanvas(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th);
  const x = out.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, tw, th);
  return out;
}

// Fast approximate blur: shrink by `factor` in halving steps, then grow back.
function blur(imageData, factor) {
  const w = imageData.width, h = imageData.height;
  const src = makeCanvas(w, h);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const sizes = [];
  let cur = src, cw = w, ch = h;
  for (let f = 1; f < factor; f *= 2) {
    const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
    const c = makeCanvas(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    sizes.push([cw, ch]);
    cur = c; cw = nw; ch = nh;
  }
  while (sizes.length) {
    const [nw, nh] = sizes.pop();
    const c = makeCanvas(nw, nh);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c;
  }
  return cur.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
}

async function loadBlob(blob) {
  if ('createImageBitmap' in window) return createImageBitmap(blob);
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

function curve(v, c) {
  v = clamp01(v);
  return v + c * (v * v * (3 - 2 * v) - v);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const to255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : v * 255 + 0.5) | 0;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Roughly normal noise, std ~1.
const gauss = (rand) => (rand() + rand() + rand() - 1.5) * 2;

// ---------- date stamp ----------

// Seven-segment digits like the orange stamp on old cameras.
const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

function drawDateStamp(ctx, w, h, date) {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const groups = [yy, mm, dd];

  const dh = Math.min(w, h) * 0.045;        // digit height
  const dw = dh * 0.55, gap = dh * 0.22, groupGap = dh * 0.55, tick = dh * 0.3;
  const thick = dh * 0.13;
  const total = tick + 6 * dw + 3 * gap + 2 * groupGap;
  const margin = Math.min(w, h) * 0.05;
  let x = w - margin - total;
  const y = h - margin - dh;

  const pass = (color, glow, width) => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.shadowColor = glow ? 'rgba(255, 100, 10, 0.95)' : 'transparent';
    ctx.shadowBlur = glow ? dh * 0.4 : 0;
    ctx.transform(1, 0, -0.1, 1, (y + dh) * 0.1, 0); // slight italic slant
    let cx = x;
    // apostrophe before the year
    ctx.beginPath();
    ctx.moveTo(cx + tick * 0.6, y);
    ctx.lineTo(cx + tick * 0.3, y + dh * 0.22);
    ctx.stroke();
    cx += tick + gap * 0.5;
    for (const group of groups) {
      for (const ch of group) {
        drawDigit(ctx, cx, y, dw, dh, SEGMENTS[ch]);
        cx += dw + gap;
      }
      cx += groupGap - gap;
    }
    ctx.restore();
  };
  pass('#ff7a1a', true, thick);        // glowing orange
  pass('#ffc070', false, thick * 0.45); // hot core
}

function drawDigit(ctx, x, y, w, h, segs) {
  const m = h / 2, p = w * 0.08;
  const lines = {
    a: [x + p, y, x + w - p, y],
    b: [x + w, y + p, x + w, y + m - p],
    c: [x + w, y + m + p, x + w, y + h - p],
    d: [x + p, y + h, x + w - p, y + h],
    e: [x, y + m + p, x, y + h - p],
    f: [x, y + p, x, y + m - p],
    g: [x + p, y + m, x + w - p, y + m],
  };
  ctx.beginPath();
  for (const s of segs) {
    const [x1, y1, x2, y2] = lines[s];
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}
