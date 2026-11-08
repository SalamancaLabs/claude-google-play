import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { buildCsv, diffCsv, loadCsvMap, run, parseCsv } from '../scripts/data-safety.mjs';

const EXAMPLE = new URL('../examples/app-content.example.yaml', import.meta.url);
const MAP = new URL('./fixtures/data-safety/map.json', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/data-safety.mjs', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'ds-'));

const reviewed = () => {
  const doc = parse(readFileSync(EXAMPLE, 'utf8'));
  const walk = (n) => { if (n && typeof n === 'object') { if (n.status === 'needs_review') { n.status = 'confirmed'; n.evidence ??= [{ note: 'x' }]; } for (const v of Object.values(n)) walk(v); } };
  walk(doc.sections.data_safety);
  return doc;
};
const writeDoc = (doc) => { const f = join(tmp, `d${Math.random()}.yaml`); writeFileSync(f, stringify(doc)); return f; };
const capture = () => { const o = [], e = []; return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) }; };

test('buildCsv maps the example through the fixture map', () => {
  const doc = reviewed();
  const rows = parseCsv(buildCsv(doc, loadCsvMap(MAP)));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[1].slice(0, 3), ['Q_COLLECTS', '', 'TRUE']);
  assert.deepEqual(rows[2].slice(0, 3), ['Q_TYPES_LOC', 'R_APPROX', 'FALSE']);
  assert.equal(rows[3][2], 'TRUE');
  assert.equal(rows[4][2], 'TRUE'); // deletion = in_app
  assert.equal(rows[5][2], 'FALSE');
});

test('buildCsv quotes commas, quotes and newlines', () => {
  const csv = buildCsv({ a: 'x,y "z"\nw' }, [{ question_id: 'Q', from: 'a', label: 'a, b' }]);
  assert.ok(csv.includes('"x,y ""z""\nw"'));
  assert.ok(csv.includes('"a, b"'));
  assert.deepEqual(parseCsv(csv)[1], ['Q', '', 'x,y "z"\nw', '', 'a, b']);
});

test('loadCsvMap rejects malformed rows', () => {
  const f = join(tmp, 'bad.json'); writeFileSync(f, '[{"question_id":"Q"}]');
  assert.throws(() => loadCsvMap(f), /"from"/);
});

test('needs_review answers are refused and listed', async () => {
  const c = capture();
  const code = await run([EXAMPLE.pathname, '--map', MAP], c);
  assert.equal(code, 1);
  assert.ok(c.e.some((l) => l.includes('sections.data_safety.security.deletion_request_mechanism')));
});

test('missing map exits 3 with message', () => {
  const r = spawnSync(process.execPath, [SCRIPT, writeDoc(reviewed()), '--map', join(tmp, 'nope.json')], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Data safety mapping table not found/);
});

test('diffCsv reports added, removed, changed', () => {
  const a = 'h\r\nQ1,R1,TRUE\r\nQ2,,FALSE\r\nQ3,,TRUE\r\n';
  const b = 'h\r\nQ1,R1,FALSE\r\nQ3,,TRUE\r\nQ4,,TRUE\r\n';
  const d = diffCsv(a, b);
  assert.deepEqual(d.changed, [{ question_id: 'Q1', response_id: 'R1', from: 'TRUE', to: 'FALSE' }]);
  assert.deepEqual(d.removed.map((r) => r.question_id), ['Q2']);
  assert.deepEqual(d.added.map((r) => r.question_id), ['Q4']);
});

test('dry run prints CSV and diff, does not call the publisher', async () => {
  const cur = join(tmp, 'cur.csv'); writeFileSync(cur, 'h\r\nQ_COLLECTS,,FALSE\r\n');
  const c = capture(); let called = false;
  const code = await run([writeDoc(reviewed()), '--map', MAP, '--current', cur], { ...c, getPublisher: async () => { called = true; } });
  assert.equal(code, 0); assert.equal(called, false);
  assert.ok(c.o.join('\n').includes('~ Q_COLLECTS: FALSE -> TRUE'));
});

test('--apply posts through the injected publisher', async () => {
  const calls = [];
  const publisher = { applications: { dataSafety: async (a) => { calls.push(a); return {}; } } };
  const c = capture();
  const code = await run([writeDoc(reviewed()), '--map', MAP, '--apply'], { ...c, getPublisher: async () => publisher });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packageName, parse(readFileSync(EXAMPLE, 'utf8')).package_name);
  assert.ok(calls[0].requestBody.safetyLabels.startsWith('Question ID'));
  const c2 = capture();
  await run([writeDoc(reviewed()), '--map', MAP, '--apply', '--package', 'com.override.app'], { ...c2, getPublisher: async () => publisher });
  assert.equal(calls[1].packageName, 'com.override.app');
});

test('--apply routes API errors through explainApiError', async () => {
  const publisher = { applications: { dataSafety: async () => { throw Object.assign(new Error('boom'), { code: 403 }); } } };
  const c = capture();
  const code = await run([writeDoc(reviewed()), '--map', MAP, '--apply'], { ...c, getPublisher: async () => publisher, explainApiError: () => 'EXPLAINED' });
  assert.equal(code, 1);
  assert.deepEqual(c.e, ['EXPLAINED']);
});
