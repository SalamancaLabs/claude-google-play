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
