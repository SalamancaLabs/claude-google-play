import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateAppContent } from './validate.mjs';

const DEFAULT_MAP = fileURLToPath(new URL('../schema/data-safety-csv-map.json', import.meta.url));
const HEADER = ['Question ID (machine readable)', 'Response (machine readable)', 'Response value', 'Answer requirement', 'Human-friendly question label'];

export const MISSING_MAP_MESSAGE =
  'Data safety mapping table not found (schema/data-safety-csv-map.json). Export the Data safety CSV from Play Console → App content → Data safety → Export to CSV, then build the mapping.';

/**
 * Mapping table: a JSON array of rows, in output order.
 * @typedef {object} CsvMapRow
 * @property {string} question_id   Play question ID, e.g. "PSL_DATA_TYPES_LOCATION".
 * @property {string} [response_id] Play response ID, e.g. "PSL_APPROX_LOCATION". Omit for single-cell questions.
 * @property {string} from          Dotted path into the app-content document (e.g. "sections.data_safety.security.encrypted_in_transit.value").
 * @property {*} [when]             If set, the row is "TRUE" when the resolved value equals it (or, for arrays, includes it), else "FALSE".
 * @property {"TRUE"|"FALSE"|string} [value] Fixed cell value (used instead of the resolved value; with `when`, used on match).
 * @property {string} [requirement] Answer requirement column (OPTIONAL, REQUIRED, ...). Default blank.
 * @property {string} [label]       Human-friendly label column. Default blank.
 * Without `when` and `value`, the resolved value is written: booleans as TRUE/FALSE, undefined/null as blank.
 */

export function loadCsvMap(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error(MISSING_MAP_MESSAGE), { code: 'MAP_MISSING' });
    throw e;
  }
  let rows;
  try { rows = JSON.parse(raw); } catch (e) { throw new Error(`${path}: invalid JSON (${e.message})`); }
  if (!Array.isArray(rows)) throw new Error(`${path}: map must be a JSON array of rows`);
  rows.forEach((r, i) => {
    const bad = (m) => { throw new Error(`${path}: row ${i}: ${m}`); };
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad('must be an object');
    for (const k of ['question_id', 'from']) if (typeof r[k] !== 'string' || !r[k]) bad(`"${k}" must be a non-empty string`);
    for (const k of ['response_id', 'requirement', 'label']) if (k in r && typeof r[k] !== 'string') bad(`"${k}" must be a string`);
    if ('value' in r && typeof r.value !== 'string') bad('"value" must be a string');
    const extra = Object.keys(r).filter((k) => !['question_id', 'response_id', 'from', 'when', 'value', 'requirement', 'label'].includes(k));
    if (extra.length) bad(`unknown field(s): ${extra.join(', ')}`);
  });
  return rows;
}

const resolve = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const bool = (b) => (b ? 'TRUE' : 'FALSE');

function cell(row, appContent) {
  const v = resolve(appContent, row.from);
  if ('when' in row) {
    const hit = Array.isArray(v) ? v.includes(row.when) : v === row.when;
    return hit ? (row.value ?? 'TRUE') : 'FALSE';
  }
  if (row.value !== undefined) return row.value;
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return bool(v);
  return String(v);
}

const quote = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function buildCsv(appContent, csvMap) {
  const lines = [HEADER, ...csvMap.map((r) => [r.question_id, r.response_id ?? '', cell(r, appContent), r.requirement ?? '', r.label ?? ''])];
  return lines.map((l) => l.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** RFC 4180 parser -> array of string[] rows. */
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') { q = true; any = true; }
    else if (c === ',') { row.push(f); f = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = ''; any = false;
    } else { f += c; any = true; }
  }
  if (any || f) { row.push(f); rows.push(row); }
  return rows;
}

/** Row-level diff keyed by (question ID, response ID). Compares the response value only. */
export function diffCsv(a, b) {
  const index = (t) => {
    const m = new Map();
    for (const r of parseCsv(t).slice(1)) m.set(`${r[0]}\u0000${r[1] ?? ''}`, { q: r[0], r: r[1] ?? '', v: r[2] ?? '' });
    return m;
  };
  const A = index(a), B = index(b);
  const added = [], removed = [], changed = [];
  for (const [k, n] of B) {
    if (!A.has(k)) added.push({ question_id: n.q, response_id: n.r, value: n.v });
    else if (A.get(k).v !== n.v) changed.push({ question_id: n.q, response_id: n.r, from: A.get(k).v, to: n.v });
  }
  for (const [k, o] of A) if (!B.has(k)) removed.push({ question_id: o.q, response_id: o.r, value: o.v });
  return { added, removed, changed };
}

function* leaves(node, path = []) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('status' in node && 'evidence' in node) yield [path, node];
    else for (const [k, v] of Object.entries(node)) yield* leaves(v, [...path, k]);
  }
}

const label = (r) => `${r.question_id}${r.response_id ? '/' + r.response_id : ''}`;

export async function run(argv, { getPublisher, explainApiError, out = console.log, err = console.error } = {}) {
  const args = { file: null, map: DEFAULT_MAP, current: null, apply: false, pkg: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map' || a === '--current' || a === '--package') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) { err(`${a} needs a value`); return 1; }
      if (a === '--map') args.map = val; else if (a === '--current') args.current = val; else args.pkg = val;
    }
    else if (a === '--apply') args.apply = true;
    else if (!args.file && !a.startsWith('--')) args.file = a;
    else { err(`unknown argument: ${a}`); return 2; }
  }
  if (!args.file) { err('usage: node scripts/data-safety.mjs <play/app-content.yaml> [--map <path>] [--current <exported.csv>] [--apply] [--package <name>]'); return 2; }

  let doc;
  try { doc = parse(readFileSync(args.file, 'utf8')); } catch (e) { err(`${args.file}: ${e.message}`); return 2; }
  const v = validateAppContent(doc);
  if (!v.ok) { for (const e of v.errors) err(`${e.path}: ${e.message}`); return 1; }

  const pending = [...leaves(doc.sections?.data_safety)].filter(([, l]) => l.status === 'needs_review').map(([p]) => ['sections', 'data_safety', ...p].join('.'));
  if (pending.length) {
    err(`Refusing: ${pending.length} Data safety answer(s) still need review:`);
    for (const p of pending) err(`  ${p}`);
    return 1;
  }

  let map;
  try { map = loadCsvMap(args.map); }
  catch (e) { err(e.message); return e.code === 'MAP_MISSING' ? 3 : 1; }

  const csv = buildCsv(doc, map);
  let current = null;
  if (args.current) {
    try { current = readFileSync(args.current, 'utf8'); }
    catch (e) { err(`Cannot read --current file ${args.current}: ${e.code ?? e.message}`); return 1; }
  }

  if (!args.apply) {
    out(csv);
    if (current !== null) {
      const d = diffCsv(current, csv);
      out(`# diff vs ${args.current}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed`);
      for (const r of d.added) out(`+ ${label(r)} = ${r.value}`);
      for (const r of d.removed) out(`- ${label(r)} = ${r.value}`);
      for (const r of d.changed) out(`~ ${label(r)}: ${r.from} -> ${r.to}`);
    }
    out('# dry run: nothing sent. Re-run with --apply to push.');
    return 0;
  }

  const packageName = args.pkg ?? doc.package_name;
  if (!packageName) { err('No package name: pass --package or set package_name in the YAML.'); return 2; }
  try {
    const publisher = await getPublisher();
    await publisher.applications.dataSafety({ packageName, requestBody: { safetyLabels: csv } });
    out(`Data safety pushed for ${packageName} (${map.length} rows).`);
    return 0;
  } catch (e) {
    err(explainApiError ? explainApiError(e, packageName) : e.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { getPublisher, explainApiError } = await import('./lib/play-client.mjs');
  process.exitCode = await run(process.argv.slice(2), { getPublisher, explainApiError });
}
