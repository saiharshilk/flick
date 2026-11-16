# Flick

One-tap photo filters in the browser. Pick one or more photos, tap a filter, and save filtered copies back to your phone, at the same aspect ratio.

Everything runs on your device. Photos are never uploaded.

**Live:** https://saiharshilk.github.io/flick/

## Filters

- **Digicam**: the early-2000s point-and-shoot look. Soft detail, colored shadow noise, crushed blacks, warm/magenta cast, blooming highlights, cheap in-camera sharpening. An orange date stamp is optional. Settings live in `DIGICAM` in `lib/digicam.js`.

## Notes

- Photos over ~16MP are scaled to fit Safari's canvas limit (same aspect ratio).
- EXIF is copied into the output, but saving to Photos on iOS through the share sheet strips location and date, so copies land at today's date.
