#!/usr/bin/env node
// Checks fastlane-layout Play graphic assets: fastlane/metadata/android/<locale>/images/...
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Requirements: Play Console Help, "Add preview assets to showcase your app"
// https://support.google.com/googleplay/android-developer/answer/9866151
// - Screenshots: JPEG or 24-bit PNG (no alpha); each side 320-3840 px; longer side at most 2x the
//   shorter side; up to 8 per device type; at least 2 screenshots to publish.
// - Feature graphic: 1024x500, JPEG or 24-bit PNG (no alpha).
// - Icon: 512x512, 32-bit PNG (with alpha), at most 1024 KB.
// - Large screens (7-inch and 10-inch tablets): each side 1080-7680 px, 16:9 or 9:16 (warned),
//   at least 4 screenshots to be featured on large screens (warned).
// - Wear OS screenshots: 1:1, at least 384x384.
// - File size: the page states 8 MB only for Android XR screenshots; for other screenshots no limit
//   is stated there, so 8 MB is an unverified, warning-only threshold.
// - EXIF orientation is ignored; Play uses the stored dimensions.
export const SCREENSHOT_DIRS = [
  'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots', 'wearScreenshots',
];
export const MAX_SCREENSHOTS = 8;
const MIN_SIDE = 320;
const MAX_SIDE = 3840;
const WEAR_MIN = 384;
const TABLET_MIN = 1080;
const TABLET_MAX = 7680;
const TABLETS = new Set(['sevenInchScreenshots', 'tenInchScreenshots']);
const ICON_MAX_BYTES = 1024 * 1024;
const SHOT_WARN_BYTES = 8 * 1024 * 1024;
const IMG_EXT = /\.(png|jpe?g)$/i;

// Returns { format: 'png'|'jpeg', width, height, alpha, bitDepth } or null when not a PNG/JPEG.
export function readImage(buf) {
  if (buf.length >= 33 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    const colorType = buf[25];
    let alpha = colorType === 4 || colorType === 6;
    for (let o = 8; o + 8 <= buf.length; ) {
      const n = buf.readUInt32BE(o);
      const type = buf.toString('latin1', o + 4, o + 8);
      if (type === 'tRNS') alpha = true;
      if (type === 'IDAT') break;
      o += 12 + n;
    }
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha, bitDepth: buf[24], colorType };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (o + 9 > buf.length) return null;
        return { format: 'jpeg', width: buf.readUInt16BE(o + 7), height: buf.readUInt16BE(o + 5), alpha: false, components: buf[o + 9] };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

const bad = (info) => !info;

export function checkImages(dir = 'fastlane/metadata/android', { defaultLocale } = {}) {
  const errors = [];
  const warnings = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, errors: [{ file: dir, message: 'listing directory not found' }], warnings };
  }
  const locales = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const err = (file, message) => errors.push({ file, message });
  const warn = (file, message) => warnings.push({ file, message });
  const load = (file) => {
    const info = readImage(readFileSync(file));
    if (bad(info)) err(file, 'not a PNG or JPEG file (checked by file contents)');
    return info;
  };
  const sizes = (l) => {
    const img = join(dir, l, 'images');
    return new Set(SCREENSHOT_DIRS.filter((d) => existsSync(join(img, d)) && statSync(join(img, d)).isDirectory()
      && readdirSync(join(img, d)).some((f) => IMG_EXT.test(f))));
  };

  let defaultTypes = null;
  if (defaultLocale) {
    if (locales.includes(defaultLocale)) defaultTypes = sizes(defaultLocale);
    else err(join(dir, defaultLocale), `default locale "${defaultLocale}" has no directory`);
  }

  for (const locale of locales) {
    const img = join(dir, locale, 'images');
    if (!existsSync(img)) {
      warn(join(dir, locale), 'no images directory');
      continue;
    }
    for (const type of SCREENSHOT_DIRS) {
      const tdir = join(img, type);
      if (!existsSync(tdir)) continue;
      const files = readdirSync(tdir).filter((f) => IMG_EXT.test(f)).sort();
      if (files.length > MAX_SCREENSHOTS) err(tdir, `${files.length} screenshots, maximum is ${MAX_SCREENSHOTS}`);
      if (TABLETS.has(type) && files.length > 0 && files.length < 4) {
        warn(tdir, `${files.length} tablet screenshot(s); at least 4 are needed to be featured on large screens`);
      }
      if (type === 'phoneScreenshots' && files.length < 2) {
        err(tdir, `${files.length} phone screenshot(s), at least 2 are needed to publish`);
      }
      for (const name of files) {
        const f = join(tdir, name);
        const info = load(f);
        if (!info) continue;
        const { width: w, height: h } = info;
        if (info.components === 4) warn(f, 'CMYK JPEG; convert to RGB');
        if (info.alpha) err(f, 'has an alpha channel; screenshots must be JPEG or 24-bit PNG');
        if (info.format === 'png' && !info.alpha && (info.bitDepth !== 8 || info.colorType === 0 || info.colorType === 3)) {
          warn(f, 'PNG is not 24-bit RGB; convert to 24-bit RGB if Play rejects it');
        }
        if (type === 'wearScreenshots') {
          if (w !== h) err(f, `${w}x${h}; Wear OS screenshots must be 1:1`);
          if (Math.min(w, h) < WEAR_MIN) err(f, `${w}x${h}; Wear OS screenshots must be at least ${WEAR_MIN}x${WEAR_MIN}`);
        } else if (TABLETS.has(type)) {
          if (Math.min(w, h) < TABLET_MIN) err(f, `${w}x${h}; tablet screenshots must be at least ${TABLET_MIN} px per side`);
          if (Math.max(w, h) > TABLET_MAX) err(f, `${w}x${h}; tablet screenshots must be at most ${TABLET_MAX} px per side`);
          if (Math.abs(Math.max(w, h) * 9 - Math.min(w, h) * 16) > Math.max(w, h) * 0.16) {
            warn(f, `${w}x${h}; tablet screenshots should be 16:9 or 9:16`);
          }
        } else {
          if (Math.min(w, h) < MIN_SIDE) err(f, `${w}x${h}; each side must be at least ${MIN_SIDE} px`);
          if (Math.max(w, h) > MAX_SIDE) err(f, `${w}x${h}; each side must be at most ${MAX_SIDE} px`);
          if (Math.max(w, h) > 2 * Math.min(w, h)) err(f, `${w}x${h}; longer side must be at most twice the shorter side`);
        }
        if (statSync(f).size > SHOT_WARN_BYTES) warn(f, 'larger than 8 MB; the console may reject it');
      }
    }
    if (!existsSync(join(img, 'phoneScreenshots'))) {
      warn(img, 'no phone screenshots');
    }
    const fg = existsSync(img) ? readdirSync(img).filter((f) => /^featureGraphic\.(png|jpe?g)$/i.test(f)) : [];
    if (fg.length > 1) warn(img, 'both featureGraphic.png and featureGraphic.jpg exist; keep one');
    for (const name of fg) {
      const f = join(img, name);
      const info = load(f);
      if (!info) continue;
      if (info.width !== 1024 || info.height !== 500) err(f, `${info.width}x${info.height}; feature graphic must be 1024x500`);
      if (info.components === 4) warn(f, 'CMYK JPEG; convert to RGB');
      if (info.alpha) err(f, 'has an alpha channel; feature graphic must be JPEG or 24-bit PNG');
    }
    const icon = join(img, 'icon.png');
    if (existsSync(icon)) {
      const info = load(icon);
      if (info) {
        if (info.format !== 'png') err(icon, 'icon must be a PNG');
        if (info.width !== 512 || info.height !== 512) err(icon, `${info.width}x${info.height}; icon must be 512x512`);
        if (info.format === 'png' && (info.colorType !== 6 || info.bitDepth !== 8)) err(icon, 'icon must be a 32-bit PNG (8-bit RGBA)');
      }
      if (statSync(icon).size > ICON_MAX_BYTES) err(icon, 'icon is larger than 1 MB');
    }
    if (defaultTypes && locale !== defaultLocale) {
      const have = sizes(locale);
      for (const type of defaultTypes) {
        if (!have.has(type)) warn(join(img, type), `missing; ${defaultLocale} has it`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--default');
  const defaultLocale = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const dir = args[0] ?? 'fastlane/metadata/android';
  const r = checkImages(dir, { defaultLocale });
  for (const e of r.errors) console.error(`error: ${e.file}: ${e.message}`);
  for (const w of r.warnings) console.warn(`warning: ${w.file}: ${w.message}`);
  console.log(r.ok ? 'images ok' : `images have ${r.errors.length} error(s)`);
  process.exit(r.ok ? 0 : 1);
}
