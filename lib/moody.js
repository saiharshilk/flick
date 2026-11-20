// Moody filter: dark, clean, expensive.
//
// Based on a popular iPhone Photos recipe (highlights down, shadows up,
// exposure and brightness down, a little contrast, black point, sharpness,
// vibrance) and pushed toward a rich, chrome-and-leather night look:
// deep but readable blacks, lamps that glow without blowing out,
// local contrast that makes metal, leather and fabric look tactile.
//
// Runs at full resolution (crisp, no grain) and works through the photo in
// strips so big iPhone photos don't run Safari out of memory.

import { stepDown, drawDateStamp } from './digicam.js';

export const MOODY = {
  // Highlights/shadows act on the neighborhood, like the iPhone sliders.
  highlights: 0.3,    // how hard bright areas are pulled down
  shadows: 0.35,      // how much dark areas are opened up
  clarity: 0.35,      // local contrast (texture on leather, chrome, fabric)
  exposure: -0.25,    // in stops
  brightness: 0.55,   // midtone darkening (gamma)
  contrast: 0.24,     // S-curve
  blackPoint: 0.022,  // deeper blacks
  whiteRoll: 0.92,    // soft shoulder so lamps never clip hard
  saturation: 0.9,    // overall color first pulled back...
  vibrance: 0.35,     // ...then muted colors brought back up
  shadowTint: [-0.006, -0.002, 0.008],  // cool, inky shadows
  highlightTint: [0.012, 0.004, -0.012], // warm lamp-light highlights
  vignette: 0.22,
  sharpen: 0.55,
  glow: 0.85,         // how much lamps / bright lights keep their original brightness
};

/**
 * @param {CanvasImageSource} source  decoded, upright image
 * @param {{width:number, height:number, dateStamp?:Date|null}} opts
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function moody(source, { width, height, dateStamp = null }) {
  const P = MOODY;
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(stepUp(source, width, height), 0, 0, width, height);

  // Neighborhood brightness maps (small, sampled with bilinear filtering).
  const coarse = lumaMap(out, width, height, 48);   // for highlights/shadows
  const fine = lumaMap(out, width, height, 420);    // for clarity

  // Lookup tables for sRGB <-> linear.
  const toLin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; toLin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  // Dark scenes get the full mood; bright daylight scenes a lighter touch.
  const night = 1 - smooth(0.32, 0.6, coarse.mean);
  const amt = 0.4 + 0.6 * night;
  const expGain = 2 ** (P.exposure * amt);
  const TP = { ...P, brightness: P.brightness * amt, contrast: P.contrast };

  const STRIP = 256;
  const cx = width / 2, cy = height / 2, maxR2 = cx * cx + cy * cy;
  const [str, stg, stb] = P.shadowTint, [htr, htg, htb] = P.highlightTint;

  for (let y0 = 0; y0 < height; y0 += STRIP) {
    const top = Math.max(0, y0 - 1), bottom = Math.min(height, y0 + STRIP + 1);
    const rows = bottom - top;
    const img = ctx.getImageData(0, top, width, rows);
    const px = img.data;
    const n = width * rows;

    // Pass 1: tone + color into a float buffer, plus luminance for sharpening.
    const rgb = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    for (let ry = 0; ry < rows; ry++) {
      const y = top + ry;
      const dy = y - cy;
      for (let x = 0; x < width; x++) {
        const i = ry * width + x, j = i * 4;
        let r = px[j] / 255, g = px[j + 1] / 255, b = px[j + 2] / 255;
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // neighborhood-aware highlights / shadows
        // (half local, half the pixel itself, which keeps halos down)
        const Lb = 0.5 * coarse.sample(x, y) + 0.5 * Y;
        const sw = 1 - smooth(0.05, 0.55, Lb);
        const hw = smooth(0.4, 0.95, Lb);
        let Yt = Y * (1 + P.shadows * sw * (1 - Y) * (1 - Y));
        Yt = Yt * (1 - P.highlights * hw * Yt);
        // clarity: exaggerate difference from the fine neighborhood (capped)
        let dl = Y - fine.sample(x, y);
        dl = dl > 0.12 ? 0.12 : dl < -0.12 ? -0.12 : dl;
        Yt += P.clarity * dl * (1 - Math.abs(2 * Y - 1)); // strongest in midtones
        let ratio = Y > 1e-4 ? Math.max(0, Yt) / Y : 1;
        r *= ratio; g *= ratio; b *= ratio;

        // exposure (in linear light)
        r = lin2srgb(srgb2lin(r) * expGain);
        g = lin2srgb(srgb2lin(g) * expGain);
        b = lin2srgb(srgb2lin(b) * expGain);

        // brightness (midtone gamma), contrast, black point, soft white shoulder,
        // applied to luminance so colors don't get pumped up as they darken
        // (half per-channel for richness, half on luminance so colors don't go neon)
        const Y2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        ratio = Y2 > 1e-4 ? tone(Y2, TP) / Y2 : 0;
        r = 0.5 * r * ratio + 0.5 * tone(r, TP);
        g = 0.5 * g * ratio + 0.5 * tone(g, TP);
        b = 0.5 * b * ratio + 0.5 * tone(b, TP);

        // color: pull back, then vibrance lifts the muted colors
        let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const k = P.saturation * (1 + P.vibrance * (1 - Math.min(1, sat * 2)));
        r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;

        // split tone: inky shadows, warm lamp light
        const ws = (1 - L) * (1 - L), wh = L * L;
        r += str * ws + htr * wh; g += stg * ws + htg * wh; b += stb * ws + htb * wh;

        // protect light sources: lamps, bulbs and signs keep their glow
        const lw = smooth(0.78, 0.98, Y) * P.glow;
        if (lw > 0) {
          const o = px[j] / 255, og = px[j + 1] / 255, ob = px[j + 2] / 255;
          r += (Math.max(r, o * 1.02) - r) * lw;
          g += (Math.max(g, og * 0.98) - g) * lw;
          b += (Math.max(b, ob * 0.92) - b) * lw;
        }

        // vignette
        const dx = x - cx;
        const v = 1 - P.vignette * ((dx * dx + dy * dy) / maxR2) ** 1.2;
        r *= v; g *= v; b *= v;

        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
        lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
    }

    // Pass 2: sharpen luminance (3x3) and write back, skipping the padding rows.
    for (let ry = y0 - top; ry < rows && top + ry < y0 + STRIP; ry++) {
      const up = Math.max(0, ry - 1), dn = Math.min(rows - 1, ry + 1);
      for (let x = 0; x < width; x++) {
        const i = ry * width + x, j = i * 4;
        const l = x > 0 ? x - 1 : x, rr = x < width - 1 ? x + 1 : x;
        const avg = (lum[up * width + x] + lum[dn * width + x] + lum[ry * width + l] + lum[ry * width + rr]) * 0.25;
        const d = P.sharpen * (lum[i] - avg);
        px[j] = to255(rgb[i * 3] + d);
        px[j + 1] = to255(rgb[i * 3 + 1] + d);
        px[j + 2] = to255(rgb[i * 3 + 2] + d);
      }
    }
    const startRow = y0 - top;
    const writeRows = Math.min(STRIP, height - y0);
    ctx.putImageData(img, 0, top, 0, startRow, width, writeRows);
  }

  if (dateStamp) drawDateStamp(ctx, width, height, dateStamp);
  return out;

  function srgb2lin(c) { return c <= 0 ? 0 : c >= 1 ? 1 : toLin[(c * 255 + 0.5) | 0]; }
}

// ---------- helpers ----------

// Enlarge small photos in 2x steps (crisper than one big jump).
function stepUp(src, tw, th) {
  let cw = src.naturalWidth || src.width, ch = src.naturalHeight || src.height;
  let cur = src;
  while (cw * 2 < tw && ch * 2 < th) {
    const c = document.createElement('canvas');
    c.width = cw * 2; c.height = ch * 2;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  return cur;
}

function lin2srgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function tone(v, P) {
  if (v < 0) v = 0;
  v = v ** (1 + P.brightness);
  v = v + P.contrast * (v * v * (3 - 2 * v) - v);
  v = (v - P.blackPoint) / (1 - P.blackPoint);
  // soft shoulder: compress the top so bright lamps roll off instead of clipping
  const s = P.whiteRoll;
  if (v > s) v = s + (1 - s) * (1 - Math.exp(-(v - s) / (1 - s)));
  return v;
}

function smooth(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

const to255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : v * 255 + 0.5) | 0;

// Small blurred luminance map with bilinear sampling in full-size coordinates.
function lumaMap(canvas, width, height, long) {
  const s = Math.min(1, long / Math.max(width, height));
  const mw = Math.max(2, Math.round(width * s)), mh = Math.max(2, Math.round(height * s));
  const small = stepDown(canvas, width, height, mw, mh);
  // extra blur: shrink to a quarter and grow back
  const tiny = document.createElement('canvas');
  tiny.width = Math.max(1, mw >> 2); tiny.height = Math.max(1, mh >> 2);
  const tctx = tiny.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(small, 0, 0, tiny.width, tiny.height);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.globalAlpha = 0.6;
  sctx.drawImage(tiny, 0, 0, mw, mh);
  const d = sctx.getImageData(0, 0, mw, mh).data;
  const map = new Float32Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) map[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  const fx = (mw - 1) / Math.max(1, width - 1), fy = (mh - 1) / Math.max(1, height - 1);
  let mean = 0;
  for (let i = 0; i < map.length; i++) mean += map[i];
  mean /= map.length;
  return {
    mean,
    sample(x, y) {
      const u = x * fx, v = y * fy;
      const x0 = u | 0, y0 = v | 0;
      const x1 = x0 + 1 < mw ? x0 + 1 : x0, y1 = y0 + 1 < mh ? y0 + 1 : y0;
      const tx = u - x0, ty = v - y0;
      const a = map[y0 * mw + x0], b = map[y0 * mw + x1], c = map[y1 * mw + x0], e = map[y1 * mw + x1];
      return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
    },
  };
}
