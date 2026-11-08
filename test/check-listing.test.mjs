import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkListing } from '../scripts/check-listing.mjs';

const fx = (n) => fileURLToPath(new URL(`./fixtures/listing/${n}`, import.meta.url));

test('valid listing passes', () => {
  const r = checkListing(fx('valid'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('over-limit title fails', () => {
  const r = checkListing(fx('long-title'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /limit is 30/);
});

test('invalid locale fails', () => {
  const r = checkListing(fx('bad-locale'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not a Google Play listing locale/.test(e.message)));
});

test('emoji in title fails', () => {
  const r = checkListing(fx('emoji-title'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /emoji/.test(e.message)));
});

test('promotional word warns', () => {
  const r = checkListing(fx('promo'));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /"best"/.test(w.message)));
});

test('default locale: optional file missing in other locale warns', () => {
  const r = checkListing(fx('default-es'), { defaultLocale: 'es-ES' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /en-US[\\/]video\.txt/.test(w.file) && /es-ES/.test(w.message)));
});

test('no default locale: cross-locale check skipped', () => {
  assert.deepEqual(checkListing(fx('default-es')).warnings, []);
});

test('default locale without directory fails', () => {
  const r = checkListing(fx('valid'), { defaultLocale: 'fr-FR' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /has no directory/);
});

test('missing required file fails', () => {
  const r = checkListing(fx('missing-file'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /full_description/.test(e.file) && /missing/.test(e.message)));
});

test('trademark sign in title passes', () => {
  assert.equal(checkListing(fx('trademark')).ok, true);
});

test('keycap emoji in title fails', () => {
  assert.equal(checkListing(fx('keycap')).ok, false);
});

test('decomposed characters count as one (30 x e + U+0301 fits)', () => {
  assert.equal(checkListing(fx('decomposed')).ok, true);
});

test('CRLF line ending is not counted', () => {
  const r = checkListing(fx('crlf'));
  assert.equal(r.ok, true);
});
