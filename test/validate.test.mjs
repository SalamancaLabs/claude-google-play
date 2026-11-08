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

const dt = (doc) => doc.sections.data_safety.data_types;
const fails = (doc, pathPrefix) => {
  const r = validateAppContent(doc);
  assert.equal(r.ok, false);
  if (pathPrefix) assert.ok(r.errors.some((e) => e.path.startsWith(pathPrefix)), JSON.stringify(r.errors));
};

test('collected=true requires purposes, ephemeral and required', () => {
  for (const drop of ['collection_purposes', 'ephemeral', 'required']) {
    const doc = load();
    delete dt(doc).app_activity.app_interactions.value[drop];
    fails(doc, 'sections.data_safety.data_types.app_activity.app_interactions');
  }
  const doc = load();
  dt(doc).app_activity.app_interactions.value.collection_purposes = [];
  fails(doc, 'sections.data_safety.data_types.app_activity.app_interactions');
});

test('shared=true requires non-empty sharing_purposes', () => {
  const doc = load();
  const v = dt(doc).app_activity.app_interactions.value;
  v.shared = true;
  fails(doc, 'sections.data_safety.data_types.app_activity.app_interactions');
  v.sharing_purposes = ['analytics'];
  assert.equal(validateAppContent(doc).ok, true);
  v.sharing_purposes = [];
  fails(doc, 'sections.data_safety.data_types.app_activity.app_interactions');
});

test('collected=false forbids ephemeral, required, collection_purposes', () => {
  for (const [k, val] of [['ephemeral', false], ['required', false], ['collection_purposes', ['analytics']]]) {
    const doc = load();
    dt(doc).location.precise_location.value[k] = val;
    fails(doc, 'sections.data_safety.data_types.location.precise_location');
  }
});

test('shared=false forbids sharing_purposes', () => {
  const doc = load();
  dt(doc).app_activity.app_interactions.value.sharing_purposes = ['analytics'];
  fails(doc, 'sections.data_safety.data_types.app_activity.app_interactions');
});

test('collects_or_shares_user_data=false needs no data_types or security', () => {
  const doc = load();
  const ds = doc.sections.data_safety;
  ds.collects_or_shares_user_data.value = false;
  fails(doc, 'sections.data_safety');
  delete ds.data_types;
  delete ds.security;
  assert.deepEqual(validateAppContent(doc).errors, []);
});

test('collects_or_shares_user_data=true requires data_types and security', () => {
  for (const k of ['data_types', 'security']) {
    const doc = load();
    delete doc.sections.data_safety[k];
    const r = validateAppContent(doc);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.message.includes(k)));
  }
});

test('evidence item may cite both file and ticket', () => {
  const doc = load();
  doc.sections.ads.contains_ads.evidence = [{ file: 'a.kt', ticket: 'T-1' }];
  assert.equal(validateAppContent(doc).ok, true);
  doc.sections.ads.contains_ads.evidence = [{ note: 'nothing cited' }];
  assert.equal(validateAppContent(doc).ok, false);
});

test('app_access: instructions required when restricted, forbidden when open', () => {
  const doc = load();
  const aa = doc.sections.app_access;
  aa.access_instructions = { value: 'user / pass', evidence: [{ owner: 'founder' }], status: 'confirmed' };
  fails(doc, 'sections.app_access');
  aa.all_functionality_available.value = false;
  assert.deepEqual(validateAppContent(doc).errors, []);
  delete aa.access_instructions;
  fails(doc, 'sections.app_access');
  aa.all_functionality_available = { value: null, evidence: [], status: 'needs_review', question: 'Is login needed?' };
  assert.deepEqual(validateAppContent(doc).errors, []);
});

test('confirmed empty string fails', () => {
  const doc = load();
  doc.sections.content_rating.category.value = '';
  fails(doc, 'sections.content_rating.category');
});

test('advertising_id: purposes required when used, empty when not', () => {
  const doc = load();
  const a = doc.sections.advertising_id;
  a.purposes.value = ['advertising_or_marketing'];
  fails(doc, 'sections.advertising_id');
  a.uses_advertising_id.value = true;
  assert.deepEqual(validateAppContent(doc).errors, []);
  a.purposes.value = [];
  fails(doc, 'sections.advertising_id');
  a.uses_advertising_id = { value: null, evidence: [], status: 'needs_review', question: 'Does the SDK read the ID?' };
  assert.deepEqual(validateAppContent(doc).errors, []);
});

const ds = (doc) => doc.sections.data_safety;
const ans = (value) => ({ value, evidence: [{ owner: 'founder' }], status: 'confirmed' });

test('data_deletion: url only with yes; value must be a known option', () => {
  const doc = load();
  ds(doc).security.data_deletion = ans('no');
  ds(doc).security.data_deletion_url = ans('https://example.com/delete');
  fails(doc, 'sections.data_safety.security');
  ds(doc).security.data_deletion = ans('maybe');
  fails(doc, 'sections.data_safety.security.data_deletion.value');
  ds(doc).security.data_deletion = ans('yes');
  assert.ok(validateAppContent(doc).ok);
});

test('account creation: description for other, deletion url for real accounts', () => {
  const doc = load();
  ds(doc).account_creation_methods = ans(['oauth']);
  fails(doc, 'sections.data_safety');
  ds(doc).account_deletion_url = ans('https://example.com/account');
  assert.ok(validateAppContent(doc).ok);
  ds(doc).account_creation_methods = ans(['oauth', 'other']);
  fails(doc, 'sections.data_safety');
  ds(doc).account_creation_description = ans('Magic link');
  assert.ok(validateAppContent(doc).ok);
  ds(doc).account_creation_methods = ans(['none']);
  delete ds(doc).account_creation_description;
  fails(doc, 'sections.data_safety');
});

test('outside-app accounts: types required when true, forbidden otherwise', () => {
  const doc = load();
  ds(doc).has_outside_app_accounts = ans(true);
  fails(doc, 'sections.data_safety');
  ds(doc).outside_app_account_types = ans(['login_with_outside_app_id']);
  assert.ok(validateAppContent(doc).ok);
  ds(doc).has_outside_app_accounts = ans(false);
  fails(doc, 'sections.data_safety');
});
