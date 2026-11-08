import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateAppContent, countStatuses } from '../scripts/validate.mjs';

const load = () => parse(readFileSync(new URL('../examples/app-content.example.yaml', import.meta.url), 'utf8'));

test('example passes and mixes both statuses', () => {
  const doc = load();
  const r = validateAppContent(doc);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  const c = countStatuses(doc);
  assert.ok(c.confirmed > 0 && c.needsReview > 0);
});

test('confirmed without evidence fails', () => {
  const doc = load();
  doc.sections.ads.contains_ads.evidence = [];
  const r = validateAppContent(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'sections.ads.contains_ads.evidence'));
});

test('unknown status fails', () => {
  const doc = load();
  doc.sections.ads.contains_ads.status = 'maybe';
  const r = validateAppContent(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'sections.ads.contains_ads.status'));
});

test('missing required section fails', () => {
  const doc = load();
  delete doc.sections.privacy_policy;
  const r = validateAppContent(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'sections' && e.message.includes('privacy_policy')));
});
