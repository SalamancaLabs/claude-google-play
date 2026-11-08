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

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function scanManifest(root, file) {
  const text = read(file);
  const rel = posix(relative(root, file));
  const variant = basename(join(file, '..'));
  const permissions = [];
  const removed = [];
  for (const m of text.matchAll(/<uses-permission(?:-sdk-23)?\b([^>]*)>/g)) {
    const a = attrs(m[1]);
    const name = a['android:name'];
    if (!name) continue;
    const item = { name, line: lineOf(text, m.index) };
    (a['tools:node'] === 'remove' ? removed : permissions).push(item);
  }
  const pkg = text.match(/<manifest\b[^>]*\bpackage="([^"]+)"/)?.[1];
  const label = text.match(/<application\b[^>]*\bandroid:label="([^"]+)"/)?.[1];
  return { file: rel, variant, permissions, removed, ...(pkg && { package: pkg }), ...(label && { label }) };
}

function scanManifests(root) {
  const found = [];
  for (const base of ['android/app/src', 'app/src']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir).sort()) {
      const f = join(dir, v, 'AndroidManifest.xml');
      if (existsSync(f)) found.push(scanManifest(root, f));
    }
  }
  return {
    main: found.filter((m) => m.variant === 'main'),
    variants: found.filter((m) => m.variant !== 'main'),
  };
}

function scanPubspec(root) {
  const file = join(root, 'pubspec.yaml');
  const text = read(file);
  if (text === null) return { name: null, deps: [] };
  let doc;
  try { doc = parse(text); } catch { return { name: null, deps: [], error: 'pubspec.yaml is not valid YAML' }; }
  const deps = Object.entries(doc?.dependencies ?? {}).map(([name, spec]) => {
    const version = typeof spec === 'string' ? spec : (spec && typeof spec === 'object' ? (spec.version ?? null) : null);
    const source = spec && typeof spec === 'object' ? (spec.sdk ? `sdk:${spec.sdk}` : spec.git ? 'git' : spec.path ? 'path' : undefined) : undefined;
    const line = text.split('\n').findIndex((l) => new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(l)) + 1;
    return { name, version, ...(source && { source }), file: 'pubspec.yaml', ...(line > 0 && { line }) };
  });
  return { name: doc?.name ?? null, deps };
}

function parseVersionCatalog(text) {
  const versions = {};
  const libs = [];
  let section = '';
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) { section = sec[1]; return; }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!kv) return;
    const [, alias, rhs] = kv;
    if (section === 'versions') {
      versions[alias] = rhs.replace(/^["']|["']$/g, '');
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
      if (name) libs.push({ name, version, alias, line: i + 1 });
    }
  });
  return libs;
}

function scanGradle(root) {
  const out = [];
  const files = [...walk(root)].filter((f) => {
    const n = basename(f);
    return n === 'build.gradle' || n === 'build.gradle.kts' || n === 'libs.versions.toml';
  });
  for (const f of files) {
    const text = read(f);
    const rel = posix(relative(root, f));
    if (basename(f) === 'libs.versions.toml') {
      for (const l of parseVersionCatalog(text)) out.push({ name: l.name, version: l.version, file: rel, line: l.line, via: `alias:${l.alias}` });
      continue;
    }
    const re = /\b(implementation|api|compileOnly|runtimeOnly|debugImplementation|releaseImplementation|kapt|ksp|classpath)\s*\(?\s*(?:platform\(\s*)?["']([^"':]+:[^"':]+(?::[^"']+)?)["']/g;
    for (const m of text.matchAll(re)) {
      const [g, n, v] = m[2].split(':');
      out.push({ name: `${g}:${n}`, version: v ?? null, configuration: m[1], file: rel, line: lineOf(text, m.index) });
    }
  }
  return out;
}

function scanApplicationIds(root) {
  const out = [];
  for (const f of walk(root)) {
    const n = basename(f);
    if (n !== 'build.gradle' && n !== 'build.gradle.kts') continue;
    const text = read(f);
    for (const m of text.matchAll(/\b(applicationId|namespace)\s*(?:=\s*)?["']([^"']+)["']/g)) {
      out.push({ kind: m[1], value: m[2], file: posix(relative(root, f)), line: lineOf(text, m.index) });
    }
  }
  return out;
}

function scanNpm(root) {
  const text = read(join(root, 'package.json'));
  if (text === null) return { name: null, deps: [] };
  let doc;
  try { doc = JSON.parse(text); } catch { return { name: null, deps: [], error: 'package.json is not valid JSON' }; }
  const deps = Object.entries(doc.dependencies ?? {}).map(([name, version]) => ({ name, version, file: 'package.json' }));
  return { name: doc.name ?? null, deps };
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
  for (const m of text.matchAll(URL_RE)) {
    yield { url: cleanUrl(m[0]), file: posix(relative(root, file)), line: lineOf(text, m.index) };
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
  return {
    identity: {
      pubspec_name: pubspec.name,
      npm_name: npm.name,
      gradle_ids: scanApplicationIds(root),
    },
    manifests: scanManifests(root),
    dependencies: { pubspec: pubspec.deps, gradle: scanGradle(root), npm: npm.deps },
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
