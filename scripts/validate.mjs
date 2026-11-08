import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const schemaUrl = new URL('../schema/app-content.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const toPath = (ptr) =>
  ptr.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')).join('.') || '(root)';

function* leaves(node, path = []) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('status' in node && 'evidence' in node) yield [path, node];
    else for (const [k, v] of Object.entries(node)) yield* leaves(v, [...path, k]);
  }
}

export function validateAppContent(obj) {
  const errors = [];
  if (!validate(obj)) {
    for (const e of validate.errors) {
      // "if" keyword reports a bare failure alongside the real "then" errors
      if (e.keyword === 'if') continue;
      const extra = e.keyword === 'additionalProperties' ? ` (${e.params.additionalProperty})` :
        '';
      errors.push({ path: toPath(e.instancePath), message: `${e.message}${extra}` });
    }
  }
  for (const [path, leaf] of leaves(obj?.sections)) {
    if (leaf.status === 'confirmed' && !(Array.isArray(leaf.evidence) && leaf.evidence.length > 0)) {
      const p = ['sections', ...path, 'evidence'].join('.');
      if (!errors.some((e) => e.path === p)) errors.push({ path: p, message: 'status "confirmed" requires at least one evidence item' });
    }
  }
  const seen = new Set();
  const unique = errors.filter((e) => !seen.has(e.path + '\0' + e.message) && seen.add(e.path + '\0' + e.message));
  return { ok: unique.length === 0, errors: unique };
}

export function countStatuses(obj) {
  let confirmed = 0, needsReview = 0;
  for (const [, leaf] of leaves(obj?.sections)) {
    if (leaf.status === 'confirmed') confirmed++;
    else if (leaf.status === 'needs_review') needsReview++;
  }
  return { confirmed, needsReview };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/validate.mjs <path.yaml>'); process.exit(2); }
  let doc;
  try { doc = parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`${file}: ${e.message}`); process.exit(2); }
  const { ok, errors } = validateAppContent(doc);
  for (const e of errors) console.error(`${e.path}: ${e.message}`);
  const { confirmed, needsReview } = countStatuses(doc);
  console.log(`${confirmed} confirmed, ${needsReview} needs review`);
  process.exit(ok ? 0 : 1);
}
