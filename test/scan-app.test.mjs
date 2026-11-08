import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanApp } from '../scripts/scan-app.mjs';

const fx = fileURLToPath(new URL('./fixtures/apps/flutter-sample', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/scan-app.mjs', import.meta.url));

test('manifest permissions and tools:node removals, with paths', () => {
  const { manifests } = scanApp(fx);
  const main = manifests.main[0];
  assert.equal(main.file, 'android/app/src/main/AndroidManifest.xml');
  assert.deepEqual(main.permissions.map((p) => p.name), ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS']); // single-quoted attr parsed, commented-out READ_CONTACTS ignored
  assert.deepEqual(main.removed.map((p) => p.name), ['com.google.android.gms.permission.AD_ID']);
  assert.equal(main.removed[0].line, 4);
  assert.equal(main.permissions[1].line, 6);
  assert.equal(main.label, 'Habitly');
});

test('debug manifest is listed separately', () => {
  const { manifests } = scanApp(fx);
  assert.equal(manifests.variants.length, 1);
  assert.equal(manifests.variants[0].variant, 'debug');
  assert.ok(manifests.variants[0].permissions.some((p) => p.name === 'android.permission.CAMERA'));
  assert.ok(!manifests.main[0].permissions.some((p) => p.name.endsWith('CAMERA')));
});

test('pubspec: dependencies only, no dev dependencies', () => {
  const names = scanApp(fx).dependencies.pubspec.map((d) => d.name);
  assert.ok(names.includes('firebase_analytics') && names.includes('http'));
  assert.ok(!names.includes('mockito') && !names.includes('flutter_test'));
  const fa = scanApp(fx).dependencies.pubspec.find((d) => d.name === 'firebase_analytics');
  assert.equal(fa.version, '^11.0.0');
  assert.equal(fa.file, 'pubspec.yaml');
});

test('gradle literal dependencies; project() refs ignored', () => {
  const g = scanApp(fx).dependencies.gradle.filter((d) => !d.via);
  assert.deepEqual(g.map((d) => [d.name, d.version]), [['com.example.sdk:sample-sdk', '1.2.3'], ['com.example.bom:managed-lib', null]]);
  assert.equal(g[0].file, 'android/app/build.gradle.kts');
});

test('BOM-managed dependency without version records its BOM', () => {
  const d = scanApp(fx).dependencies.gradle.find((x) => x.name === 'com.example.bom:managed-lib');
  assert.equal(d.version, null);
  assert.equal(d.managed_by, 'com.example.bom:sample-bom:5.0.0');
});

test('version catalog: referenced libs vs declared_only; test libs excluded', () => {
  const { gradle, excluded } = scanApp(fx).dependencies;
  const byName = Object.fromEntries(gradle.filter((d) => d.via).map((d) => [d.name, d]));
  assert.equal(byName['com.squareup.okhttp3:okhttp'].declared_only, false);
  assert.equal(byName['com.squareup.okhttp3:okhttp'].version, '4.12.0');
  assert.equal(byName['com.example.unused:unused'].declared_only, true);
  assert.ok(!byName['junit:junit']);
  const ex = excluded.map((d) => d.name);
  assert.ok(ex.includes('junit:junit') && ex.includes('com.example.test:mock') && ex.includes('mockito') && ex.includes('flutter_test'));
});

test('network hosts deduped, interpolated URLs and build/ skipped', () => {
  const hosts = scanApp(fx).network_hosts;
  assert.deepEqual(hosts.map((h) => h.host), ['api.example.org', 'example.org']);
  assert.deepEqual(hosts[0].sites[0], { file: 'lib/main.dart', line: 3 });
});

test('privacy policy candidates from source and README', () => {
  const urls = scanApp(fx).privacy_policy_candidates.map((c) => `${c.url} ${c.file}`);
  assert.ok(urls.includes('https://example.org/habitly/privacy-policy lib/main.dart'));
  assert.ok(urls.includes('https://example.org/habitly/privacy README.md'));
});

test('identity and locales', () => {
  const s = scanApp(fx);
  assert.equal(s.identity.pubspec_name, 'habitly');
  assert.ok(s.identity.gradle_ids.some((i) => i.kind === 'applicationId' && i.value === 'com.example.habitly'));
  assert.deepEqual(s.locales.fastlane.map((l) => l.locale), ['en-US', 'es-ES']);
});

test('CLI prints JSON', () => {
  const out = JSON.parse(execFileSync('node', [cli, fx], { encoding: 'utf8' }));
  assert.equal(out.identity.pubspec_name, 'habitly');
});

test('missing repo yields empty facts, not a crash', () => {
  const s = scanApp(fx + '-nope');
  assert.deepEqual(s.dependencies, { pubspec: [], gradle: [], npm: [], excluded: [] });
  assert.deepEqual(s.manifests, { main: [], variants: [] });
});

test('large, minified and binary files are skipped; big text stays fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib/huge.dart'), "const a = 'https://huge.example.net/x';\n".repeat(60000)); // > 1.5 MB
    writeFileSync(join(dir, 'lib/app.min.js'), "var a='https://min.example.net/x';");
    writeFileSync(join(dir, 'lib/blob.dart'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("'https://bin.example.net/x'")]));
    writeFileSync(join(dir, 'lib/big.dart'), "const a = 'https://big.example.net/x';\n".repeat(20000)); // ~0.7 MB, scanned
    const t = Date.now();
    const hosts = scanApp(dir).network_hosts;
    assert.ok(Date.now() - t < 3000, 'scan too slow');
    assert.deepEqual(hosts.map((h) => h.host), ['big.example.net']);
    assert.equal(hosts[0].sites.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
