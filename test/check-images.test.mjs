import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { checkImages, readImage } from '../scripts/check-images.mjs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
};
// Solid-color PNG; alpha=true gives 32-bit RGBA, otherwise 24-bit RGB.
const png = (w, h, alpha = false) => {
  const bpp = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * bpp, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
// Minimal JPEG header (SOI, SOF0, EOI); enough for dimension parsing.
const jpeg = (w, h) => {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17 - 0, 0); sof[2] = 8; sof.writeUInt16BE(h, 3); sof.writeUInt16BE(w, 5); sof[7] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])]);
};

let root;
let n = 0;
before(() => { root = mkdtempSync(join(tmpdir(), 'check-images-')); });
after(() => rmSync(root, { recursive: true, force: true }));

// Builds <root>/<case>/<locale>/images with given { 'path/rel/to/images': Buffer }.
const build = (files, locale = 'en-US') => {
  const dir = join(root, `case${n++}`);
  for (const [rel, buf] of Object.entries(files)) {
    const f = join(dir, locale, 'images', rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, buf);
  }
  return dir;
};
const phones = (count, w = 1080, h = 1920) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`phoneScreenshots/${i + 1}_s.png`, png(w, h)]));

test('valid set passes', () => {
  const dir = build({
    ...phones(2, 360, 640),
    'featureGraphic.png': png(1024, 500),
    'icon.png': png(512, 512, true),
  });
  const r = checkImages(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('PNG with alpha screenshot fails', () => {
  const files = phones(2, 360, 640);
  files['phoneScreenshots/2_s.png'] = png(360, 640, true);
  const r = checkImages(build(files));
  assert.ok(r.errors.some((e) => /2_s\.png/.test(e.file) && /alpha/.test(e.message)));
});

test('too-small dimension fails', () => {
  const r = checkImages(build(phones(2, 300, 600)));
  assert.ok(r.errors.some((e) => /at least 320/.test(e.message)));
});

test('aspect ratio above 2:1 fails', () => {
  const r = checkImages(build(phones(2, 320, 700)));
  assert.ok(r.errors.some((e) => /twice/.test(e.message)));
});

test('9 screenshots fails', () => {
  const r = checkImages(build(phones(9, 360, 640)));
  assert.ok(r.errors.some((e) => /maximum is 8/.test(e.message)));
});

test('1 phone screenshot fails', () => {
  const r = checkImages(build(phones(1, 360, 640)));
  assert.ok(r.errors.some((e) => /at least 2/.test(e.message)));
});

test('no phone screenshots only warns', () => {
  const r = checkImages(build({ 'icon.png': png(512, 512, true) }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /no phone screenshots/.test(w.message)));
});

test('icon wrong size fails', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), 'icon.png': png(256, 256, true) }));
  assert.ok(r.errors.some((e) => /icon must be 512x512/.test(e.message)));
});

test('feature graphic wrong size fails', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), 'featureGraphic.png': png(1024, 501) }));
  assert.ok(r.errors.some((e) => /1024x500/.test(e.message)));
});

test('.png extension with JPEG bytes is detected as JPEG', () => {
  const buf = jpeg(360, 640);
  assert.deepEqual(readImage(buf), { format: 'jpeg', width: 360, height: 640, alpha: false, components: 3 });
  const files = phones(1, 360, 640);
  files['phoneScreenshots/2_s.png'] = buf;
  const r = checkImages(build(files));
  assert.deepEqual(r.errors, []);
});

test('non-image bytes fail', () => {
  const files = phones(1, 360, 640);
  files['phoneScreenshots/2_s.png'] = Buffer.from('nope');
  const r = checkImages(build(files));
  assert.ok(r.errors.some((e) => /not a PNG or JPEG/.test(e.message)));
});

test('default locale: missing device type warns', () => {
  const dir = build({ ...phones(2, 360, 640), ...Object.fromEntries([1, 2, 3, 4].map((i) => [`tenInchScreenshots/${i}_s.png`, png(1080, 1920)])) }, 'en-US');
  const f = join(dir, 'es-ES', 'images', 'phoneScreenshots');
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, '1_s.png'), png(360, 640));
  writeFileSync(join(f, '2_s.png'), png(360, 640));
  const r = checkImages(dir, { defaultLocale: 'en-US' });
  assert.ok(r.warnings.some((w) => /es-ES/.test(w.file) && /tenInch/.test(w.file)));
  assert.deepEqual(checkImages(dir).warnings, []);
});

const tablets = (count, w, h) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`tenInchScreenshots/${i + 1}_s.png`, png(w, h)]));

test('tablet 800x1280 fails', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), ...tablets(4, 800, 1280) }));
  assert.ok(r.errors.some((e) => /at least 1080/.test(e.message)));
});

test('tablet 3840x2160 passes', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), ...tablets(4, 3840, 2160) }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('tablet 4:3 warns', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), ...tablets(4, 1600, 1200) }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /16:9/.test(w.message)));
});

test('2 tablet files warn', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), ...tablets(2, 1920, 1080) }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /at least 4/.test(w.message)));
});

test('feature graphic png and jpg both present warns', () => {
  const r = checkImages(build({ ...phones(2, 360, 640), 'featureGraphic.png': png(1024, 500), 'featureGraphic.jpg': jpeg(1024, 500) }));
  assert.ok(r.warnings.some((w) => /keep one/.test(w.message)));
});
