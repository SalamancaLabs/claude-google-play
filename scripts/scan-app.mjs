import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SKIP_DIRS = new Set(['build', '.dart_tool', 'node_modules', '.git', '.gradle', 'Pods', '.idea']);
const CODE_EXT = new Set(['.dart', '.kt', '.java', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEXT_EXT = new Set([...CODE_EXT, '.md', '.txt', '.yaml', '.yml', '.json', '.html']);
const SOURCE_ROOTS = ['lib', 'src', 'app/src/main', 'android/app/src/main'];
const IGNORED_HOSTS = new Set(['schemas.android.com', 'www.w3.org', 'www.apache.org', 'apache.org']);
const MAX_SITES_PER_HOST = 5;

const posix = (p) => p.split(sep).join('/');

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.isFile()) yield join(dir, e.name);
  }
}

const MAX_BYTES = 1.5 * 1024 * 1024;

// Returns null for unreadable, oversized, minified or binary files.
const read = (f) => {
  try {
    if (/\.min\./.test(basename(f))) return null;
    if (statSync(f).size > MAX_BYTES) return null;
    const buf = readFileSync(f);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString('utf8');
  } catch { return null; }
};

// Line numbers from a per-file table of newline offsets (binary search), computed once.
function liner(text) {
  const nl = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nl.push(i);
  return (index) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < index) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
}

const stripXmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

function scanManifest(root, file) {
  const raw = read(file);
  if (raw === null) return null;
  const text = stripXmlComments(raw);
  const lineOf = liner(text);
  const rel = posix(relative(root, file));
  const variant = basename(join(file, '..'));
  const permissions = [];
  const removed = [];
  for (const m of text.matchAll(/<uses-permission(?:-sdk-23)?\b([^>]*)>/g)) {
    const a = attrs(m[1]);
    const name = a['android:name'];
    if (!name) continue;
    const item = { name, line: lineOf(m.index) };
    (a['tools:node'] === 'remove' ? removed : permissions).push(item);
  }
  const pkg = attrs(text.match(/<manifest\b([^>]*)>/)?.[1] ?? '').package;
  const label = attrs(text.match(/<application\b([^>]*)>/)?.[1] ?? '')['android:label'];
  return { file: rel, variant, permissions, removed, ...(pkg && { package: pkg }), ...(label && { label }) };
}

function scanManifests(root) {
  const found = [];
  for (const base of ['android/app/src', 'app/src']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir).sort()) {
      const f = join(dir, v, 'AndroidManifest.xml');
      if (existsSync(f)) { const m = scanManifest(root, f); if (m) found.push(m); }
    }
  }
  return {
    main: found.filter((m) => m.variant === 'main'),
    variants: found.filter((m) => m.variant !== 'main'),
  };
}

function scanPubspec(root) {
  const text = read(join(root, 'pubspec.yaml'));
  if (text === null) return { name: null, deps: [], excluded: [] };
  let doc;
  try { doc = parse(text); } catch { return { name: null, deps: [], excluded: [], error: 'pubspec.yaml is not valid YAML' }; }
  const lines = text.split('\n');
  const entries = (obj, kind) => Object.entries(obj ?? {}).map(([name, spec]) => {
    const version = typeof spec === 'string' ? spec : (spec && typeof spec === 'object' ? (spec.version ?? null) : null);
    const source = spec && typeof spec === 'object' ? (spec.sdk ? `sdk:${spec.sdk}` : spec.git ? 'git' : spec.path ? 'path' : undefined) : undefined;
    const re = new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    const line = lines.findIndex((l) => re.test(l)) + 1;
    return { name, version, ...(source && { source }), ...(kind && { kind }), file: 'pubspec.yaml', ...(line > 0 && { line }) };
  });
  return { name: doc?.name ?? null, deps: entries(doc?.dependencies), excluded: entries(doc?.dev_dependencies, 'dev_dependencies') };
}

const TEST_CONFIG = /^(test|androidTest|kaptTest|kaptAndroidTest|testFixtures)\w*$/;

function parseVersionCatalog(text) {
  const lineOf = liner(text);
  const versions = {};
  const libs = [];
  const bundles = {};
  let section = '';
  let pos = 0;
  text.split('\n').forEach((raw) => {
    const lineStart = pos;
    pos += raw.length + 1;
    const line = raw.replace(/#.*$/, '').trim();
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) { section = sec[1]; return; }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!kv) return;
    const [, alias, rhs] = kv;
    if (section === 'versions') {
      versions[alias] = rhs.replace(/^["']|["']$/g, '');
    } else if (section === 'bundles') {
      bundles[alias] = [...rhs.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    } else if (section === 'libraries') {
      let name = null, version = null;
      const str = rhs.match(/^["']([^"']+)["']$/);
      if (str) {
        const [g, n, v] = str[1].split(':');
        name = `${g}:${n}`; version = v ?? null;
      } else {
        const module = rhs.match(/module\s*=\s*["']([^"']+)["']/)?.[1];
        const group = rhs.match(/group\s*=\s*["']([^"']+)["']/)?.[1];
        const nm = rhs.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1];
        name = module ?? (group && nm ? `${group}:${nm}` : null);
        const ref = rhs.match(/version\.ref\s*=\s*["']([^"']+)["']/)?.[1];
        const direct = rhs.match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1];
        version = ref ? (versions[ref] ?? null) : (direct ?? null);
      }
      if (name) libs.push({ name, version, alias, line: lineOf(lineStart) });
    }
  });
  return { libs, bundles };
}

const normAlias = (a) => a.replace(/[-_]/g, '.');

function scanGradle(root) {
  const deps = [];
  const excluded = [];
  const files = [...walk(root)].filter((f) => {
    const n = basename(f);
    return n === 'build.gradle' || n === 'build.gradle.kts' || n === 'libs.versions.toml';
  });
  const catalogs = [];
  const refs = new Map(); // normalized alias or "bundles.x" -> Set(configuration)
  const addRef = (k, cfg) => { if (!refs.has(k)) refs.set(k, new Set()); refs.get(k).add(cfg); };
  const re = /\b(\w+)\s*\(?\s*(?:platform\(\s*)?["']([^"':]+:[^"':]+(?::[^"']+)?)["']/g;
  const CONFIG = /^(implementation|api|compileOnly|runtimeOnly|debugImplementation|releaseImplementation|profileImplementation|kapt|ksp|classpath)$/;
  for (const f of files) {
    const text = read(f);
    if (text === null) continue;
    const rel = posix(relative(root, f));
    if (basename(f) === 'libs.versions.toml') { catalogs.push({ rel, ...parseVersionCatalog(text) }); continue; }
    const lineOf = liner(text);
    const boms = [...text.matchAll(/platform\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const m of text.matchAll(re)) {
      const cfg = m[1];
      const isTest = TEST_CONFIG.test(cfg);
      if (!isTest && !CONFIG.test(cfg)) continue;
      const [g, n, v] = m[2].split(':');
      const item = { name: `${g}:${n}`, version: v ?? null, configuration: cfg, file: rel, line: lineOf(m.index) };
      if (item.version === null && boms.length && !m[0].includes('platform(')) item.managed_by = boms[0];
      (isTest ? excluded : deps).push(item);
    }
    for (const m of text.matchAll(/\b(\w+)\s*\(\s*(?:platform\(\s*)?libs\.([\w.]+)/g)) {
      const ref = m[2];
      addRef(ref.startsWith('bundles.') ? ref.split('.').slice(0, 2).join('.') : ref, m[1]);
    }
  }
  const usedBy = (alias) => {
    const na = normAlias(alias);
    const cfgs = new Set();
    for (const [ref, set] of refs) if (ref === na || ref.startsWith(na + '.')) set.forEach((c) => cfgs.add(c));
    return cfgs;
  };
  for (const c of catalogs) {
    const bundleCfgs = new Map();
    for (const [bname, members] of Object.entries(c.bundles)) {
      const set = refs.get(`bundles.${normAlias(bname)}`);
      if (set) for (const mem of members) bundleCfgs.set(normAlias(mem), new Set([...(bundleCfgs.get(normAlias(mem)) ?? []), ...set]));
    }
    for (const l of c.libs) {
      const cfgs = new Set([...usedBy(l.alias), ...(bundleCfgs.get(normAlias(l.alias)) ?? [])]);
      const item = { name: l.name, version: l.version, file: c.rel, line: l.line, via: `alias:${l.alias}` };
      if (cfgs.size === 0) deps.push({ ...item, declared_only: true });
      else if ([...cfgs].every((x) => TEST_CONFIG.test(x))) excluded.push({ ...item, configuration: [...cfgs].join(',') });
      else deps.push({ ...item, declared_only: false });
    }
  }
  return { deps, excluded };
}

function scanApplicationIds(root) {
  const out = [];
  for (const f of walk(root)) {
    const n = basename(f);
    if (n !== 'build.gradle' && n !== 'build.gradle.kts') continue;
    const text = read(f);
    if (text === null) continue;
    const lineOf = liner(text);
    for (const m of text.matchAll(/\b(applicationId|namespace)\s*(?:=\s*)?["']([^"']+)["']/g)) {
      out.push({ kind: m[1], value: m[2], file: posix(relative(root, f)), line: lineOf(m.index) });
    }
  }
  return out;
}

function scanNpm(root) {
  const text = read(join(root, 'package.json'));
  if (text === null) return { name: null, deps: [], excluded: [] };
  let doc;
  try { doc = JSON.parse(text); } catch { return { name: null, deps: [], excluded: [], error: 'package.json is not valid JSON' }; }
  const entries = (o, kind) => Object.entries(o ?? {}).map(([name, version]) => ({ name, version, ...(kind && { kind }), file: 'package.json' }));
  return { name: doc.name ?? null, deps: entries(doc.dependencies), excluded: entries(doc.devDependencies, 'devDependencies') };
}

function* sourceFiles(root, exts) {
  const seen = new Set();
  for (const r of SOURCE_ROOTS) {
    const dir = join(root, r);
    if (!existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (exts.has(extname(f)) && !seen.has(f)) { seen.add(f); yield f; }
    }
  }
}

function* docFiles(root) {
  let top = [];
  try { top = readdirSync(root); } catch { /* none */ }
  for (const n of top.sort()) {
    const f = join(root, n);
    if (/^readme/i.test(n) && statSync(f).isFile()) yield f;
  }
  const fl = join(root, 'fastlane');
  if (existsSync(fl)) for (const f of walk(fl)) if (TEXT_EXT.has(extname(f))) yield f;
}

const URL_RE = /https?:\/\/[^\s"'`<>()[\]\\*,;]+/g;
const cleanUrl = (u) => u.replace(/[.:!?]+$/, '');

function* urlsIn(file, root) {
  const text = read(file);
  if (text === null) return;
  const lineOf = liner(text);
  for (const m of text.matchAll(URL_RE)) {
    yield { url: cleanUrl(m[0]), file: posix(relative(root, file)), line: lineOf(m.index) };
  }
}

function scanNetworkHosts(root) {
  const hosts = new Map();
  for (const f of sourceFiles(root, CODE_EXT)) {
    for (const hit of urlsIn(f, root)) {
      if (/[${}]/.test(hit.url)) continue;
      let host;
      try { host = new URL(hit.url).hostname; } catch { continue; }
      if (!host || IGNORED_HOSTS.has(host)) continue;
      const sites = hosts.get(host) ?? [];
      if (sites.length < MAX_SITES_PER_HOST) sites.push({ file: hit.file, line: hit.line });
      hosts.set(host, sites);
    }
  }
  return [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, sites]) => ({ host, sites }));
}

function scanPrivacyCandidates(root) {
  const out = [];
  const seen = new Set();
  const files = [...sourceFiles(root, TEXT_EXT), ...docFiles(root)];
  for (const f of files) {
    for (const hit of urlsIn(f, root)) {
      if (!/privacy/i.test(hit.url)) continue;
      const key = `${hit.url}\0${hit.file}`;
      if (!seen.has(key)) { seen.add(key); out.push(hit); }
    }
  }
  return out;
}

function scanLocales(root) {
  const loc = { fastlane: [], res: [], arb: [] };
  const fl = join(root, 'fastlane/metadata/android');
  if (existsSync(fl)) {
    for (const n of readdirSync(fl).sort()) if (statSync(join(fl, n)).isDirectory()) loc.fastlane.push({ locale: n, file: `fastlane/metadata/android/${n}` });
  }
  const res = join(root, 'android/app/src/main/res');
  if (existsSync(res)) {
    for (const n of readdirSync(res).sort()) {
      const m = n.match(/^values-([a-z]{2}(?:-r[A-Z]{2})?)$/);
      if (m) loc.res.push({ locale: m[1], file: `android/app/src/main/res/${n}` });
    }
  }
  const l10n = join(root, 'lib/l10n');
  if (existsSync(l10n)) {
    for (const n of readdirSync(l10n).sort()) {
      const m = n.match(/^[\w]+?_([a-z]{2}(?:_[A-Z]{2})?)\.arb$/);
      if (m) loc.arb.push({ locale: m[1], file: `lib/l10n/${n}` });
    }
  }
  return loc;
}

export function scanApp(repoDir) {
  const root = repoDir;
  const pubspec = scanPubspec(root);
  const npm = scanNpm(root);
  const gradle = scanGradle(root);
  return {
    identity: {
      pubspec_name: pubspec.name,
      npm_name: npm.name,
      gradle_ids: scanApplicationIds(root),
    },
    manifests: scanManifests(root),
    dependencies: {
      pubspec: pubspec.deps,
      gradle: gradle.deps,
      npm: npm.deps,
      // dev/test-only dependencies: not shipped in the release app
      excluded: [...pubspec.excluded, ...gradle.excluded, ...npm.excluded],
    },
    network_hosts: scanNetworkHosts(root),
    privacy_policy_candidates: scanPrivacyCandidates(root),
    locales: scanLocales(root),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/scan-app.mjs <repoDir>'); process.exit(2); }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`${dir}: not a directory`); process.exit(2); }
  console.log(JSON.stringify(scanApp(dir), null, 2));
}
