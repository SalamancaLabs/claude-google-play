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
  const rows = parseCsv(buildCsv(reviewed(), loadCsvMap(MAP)));
  assert.deepEqual(rows[0].slice(0, 3), ['Question ID (machine readable)', 'Response ID (machine readable)', 'Response value']);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1].slice(0, 3), ['Q_COLLECTS', '', 'true']);
  assert.deepEqual(rows[2].slice(0, 3), ['Q_TYPES_LOC', 'R_APPROX', '']); // not collected, not shared: blank
  assert.equal(rows[3][2], 'true');
  assert.equal(rows[4][2], 'true'); // deletion = yes
  assert.equal(rows[5][2], ''); // unselected choice stays blank
  assert.equal(rows[6][2], ''); // blank row
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
  assert.ok(c.e.some((l) => l.includes('sections.data_safety.security.data_deletion')));
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
  assert.ok(c.o.join('\n').includes('~ Q_COLLECTS: FALSE -> true'));
});

test('--apply posts through the injected publisher', async () => {
  const calls = [];
  const publisher = { applications: { dataSafety: async (a) => { calls.push(a); return {}; } } };
  const c = capture();
  const code = await run([writeDoc(reviewed()), '--map', MAP, '--apply'], { ...c, getPublisher: async () => publisher });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packageName, parse(readFileSync(EXAMPLE, 'utf8')).package_name);
  assert.ok(calls[0].requestBody.safetyLabels.startsWith('Question ID (machine readable),Response ID (machine readable),'));
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

test('missing flag values and unreadable files exit 1 cleanly', async () => {
  const f = writeDoc(reviewed());
  for (const argv of [[f, '--map'], [f, '--map', MAP, '--current'], [f, '--map', MAP, '--current', join(tmp, 'absent.csv')], [f, '--map', tmp]]) {
    const c = capture();
    assert.equal(await run(argv, c), 1, argv.join(' '));
    assert.equal(c.e.length >= 1, true);
  }
});

const REAL_MAP = new URL('../schema/data-safety-csv-map.json', import.meta.url).pathname;
const TEMPLATE = parseCsv(readFileSync(new URL('../schema/data-safety-template.csv', import.meta.url), 'utf8')).slice(1);
const schema = JSON.parse(readFileSync(new URL('../schema/app-content.schema.json', import.meta.url), 'utf8'));

test('template carries structure only: no response values', () => {
  assert.equal(TEMPLATE.length, 782);
  assert.ok(TEMPLATE.every((r) => r.length === 5 && r[2] === ''));
});

test('every template row is mapped exactly once, and the map has no extra rows', () => {
  const map = loadCsvMap(REAL_MAP);
  const key = (q, r) => `${q}\u0000${r ?? ''}`;
  const seen = new Map();
  for (const m of map) seen.set(key(m.question_id, m.response_id), (seen.get(key(m.question_id, m.response_id)) ?? 0) + 1);
  assert.ok([...seen.values()].every((n) => n === 1), 'duplicate map rows');
  assert.equal(map.length, TEMPLATE.length);
  for (const [q, r, , req, label] of TEMPLATE) assert.equal(seen.get(key(q, r)), 1, `${q} ${r} not mapped`);
  map.forEach((m, i) => {
    assert.deepEqual([m.question_id, m.response_id ?? '', m.requirement, m.label], [TEMPLATE[i][0], TEMPLATE[i][1], TEMPLATE[i][3], TEMPLATE[i][4]], `row ${i} differs from template`);
  });
});

test('buildCsv yields exactly the template rows in the template order', () => {
  const rows = parseCsv(buildCsv(reviewed(), loadCsvMap(REAL_MAP))).slice(1);
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[3], r[4]]), TEMPLATE.map((r) => [r[0], r[1], r[3], r[4]]));
});

test('every data_safety schema field is read by at least one map row', () => {
  const props = schema.properties.sections.properties.data_safety.properties;
  const paths = [];
  const walk = (node, path) => {
    if (node.$ref?.endsWith('_answer') || node.$ref?.endsWith('/answer')) { paths.push(path.join('.')); return; }
    const kids = node.properties ?? (node.$ref ? schema.$defs[node.$ref.split('/').pop()].properties : null);
    if (!kids) throw new Error(`unexpected node at ${path.join('.')}`);
    for (const [k, v] of Object.entries(kids)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(props)) walk(v, ['sections', 'data_safety', k]);
  assert.equal(paths.length, 50); // 38 data types + 12 other answers
  const used = loadCsvMap(REAL_MAP).flatMap((m) => (m.from ? [m.from].flat() : []));
  for (const p of paths) {
    const hits = used.filter((u) => u === `${p}.value` || u.startsWith(`${p}.value.`));
    assert.ok(hits.length >= 1, `${p} is not mapped`);
  }
});

test('collected data type fills its template rows', () => {
  const doc = reviewed();
  const ds = doc.sections.data_safety;
  ds.data_types.location.approximate_location.value = { collected: true, shared: false, ephemeral: false, required: false, collection_purposes: ['analytics'] };
  const rows = parseCsv(buildCsv(doc, loadCsvMap(REAL_MAP)));
  const val = (q, r = '') => rows.find((x) => x[0] === q && x[1] === r)[2];
  assert.equal(val('PSL_DATA_TYPES_LOCATION', 'PSL_APPROX_LOCATION'), 'true');
  assert.equal(val('PSL_DATA_USAGE_RESPONSES:PSL_APPROX_LOCATION:PSL_DATA_USAGE_COLLECTION_AND_SHARING', 'PSL_DATA_USAGE_ONLY_COLLECTED'), 'true');
  assert.equal(val('PSL_DATA_USAGE_RESPONSES:PSL_APPROX_LOCATION:PSL_DATA_USAGE_EPHEMERAL'), 'false');
  assert.equal(val('PSL_DATA_USAGE_RESPONSES:PSL_APPROX_LOCATION:DATA_USAGE_USER_CONTROL', 'PSL_DATA_USAGE_USER_CONTROL_OPTIONAL'), 'true');
  assert.equal(val('PSL_DATA_USAGE_RESPONSES:PSL_APPROX_LOCATION:DATA_USAGE_COLLECTION_PURPOSE', 'PSL_ANALYTICS'), 'true');
  assert.equal(val('PSL_DATA_USAGE_RESPONSES:PSL_APPROX_LOCATION:DATA_USAGE_COLLECTION_PURPOSE', 'PSL_ADVERTISING'), '');
});
