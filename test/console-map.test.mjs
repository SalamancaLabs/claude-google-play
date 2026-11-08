import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const schema = JSON.parse(read('../schema/app-content.schema.json'));
const map = parse(read('../skills/app-content/console-map.yaml'));

const schemaSections = schema.properties.sections.properties;
const keys = (o) => Object.keys(o).sort();
const inScope = keys(schemaSections).filter((k) => k !== 'data_safety');

test('map covers exactly the non-data_safety sections', () => {
  assert.deepEqual(keys(map.sections), inScope);
});

test('map question keys match schema question keys per section', () => {
  for (const s of inScope) {
    assert.deepEqual(keys(map.sections[s].questions), keys(schemaSections[s].properties), s);
  }
});

test('every section has source URLs and navigation', () => {
  for (const s of inScope) {
    const sec = map.sections[s];
    assert.ok(Array.isArray(sec.source) && sec.source.length > 0, `${s} source`);
    for (const u of sec.source) assert.match(u, /^https:\/\//, `${s} source url`);
    assert.ok(sec.card && sec.open_button?.length && sec.save_button, `${s} navigation`);
  }
});

test('every question has label, control, map and verified: false', () => {
  for (const s of inScope) {
    for (const [q, e] of Object.entries(map.sections[s].questions)) {
      assert.ok(e.label, `${s}.${q} label`);
      assert.ok(e.control, `${s}.${q} control`);
      assert.ok(e.map, `${s}.${q} map`);
      assert.equal(e.verified, false, `${s}.${q} verified`);
    }
  }
});
