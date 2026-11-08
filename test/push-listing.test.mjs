import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/push-listing.mjs';
import { checkListing } from '../scripts/check-listing.mjs';
import { explainApiError, withEdit } from '../scripts/lib/play-client.mjs';

const valid = fileURLToPath(new URL('./fixtures/listing/valid', import.meta.url));
const ok = () => ({ ok: true, errors: [], warnings: [] });
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Temp copy of the valid fixture with images under en-US.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  cpSync(valid, dir, { recursive: true });
  const img = join(dir, 'en-US', 'images');
  mkdirSync(join(img, 'phoneScreenshots'), { recursive: true });
  writeFileSync(join(img, 'phoneScreenshots', '1.png'), 'p1');
  writeFileSync(join(img, 'phoneScreenshots', '2.png'), 'p2');
  writeFileSync(join(img, 'icon.png'), 'icon');
  return dir;
}
const text = (dir, l, f) => readFileSync(join(dir, l, f), 'utf8').replace(/\r?\n$/, '');

function fake({ listings = [], images = {}, failOn } = {}) {
  const calls = [];
  const rec = (name) => async (p) => {
    calls.push(name);
    if (failOn === name) throw Object.assign(new Error('boom'), { code: 400 });
    return { data: {} };
  };
  const pub = { calls,
    edits: {
      insert: async () => { calls.push('insert'); return { data: { id: 'E1' } }; },
      delete: rec('delete'), commit: rec('commit'), validate: rec('validate'),
      listings: { list: async () => ({ data: { listings } }), update: async (p) => { calls.push('listings.update:' + p.language); if (failOn === 'listings.update') throw new Error('x'); return { data: {} }; } },
      images: {
        list: async (p) => ({ data: { images: images[`${p.language}/${p.imageType}`] ?? [] } }),
        deleteall: async (p) => { calls.push(`deleteall:${p.imageType}`); return { data: {} }; },
        upload: async (p) => { calls.push(`upload:${p.imageType}`); if (failOn === 'upload') throw Object.assign(new Error('boom'), { code: 400 }); return { data: {} }; },
      },
    },
  };
  return pub;
}
const deps = (pub, extra = {}) => ({
  getPublisher: async () => pub, checkListing: ok, checkImages: ok, log: () => {}, err: () => {}, ...extra,
});
const args = (dir, more = []) => ['--package', 'com.example.app', '--default', 'en-US', dir, ...more];
const remoteOf = (dir, l) => ({ language: l, title: text(dir, l, 'title.txt'), shortDescription: text(dir, l, 'short_description.txt'), fullDescription: text(dir, l, 'full_description.txt') });

test('dry run never writes and always deletes the edit', async () => {
  const dir = setup();
  const pub = fake({ listings: [{ language: 'en-US', title: 'Old' }] });
  assert.equal(await run(args(dir), deps(pub)), 0);
  assert.ok(pub.calls.includes('delete'));
  for (const c of pub.calls) assert.doesNotMatch(c, /update|upload|deleteall|commit|validate/);
});

test('apply updates only changed locales and image types, then validates and commits', async () => {
  const dir = setup();
  const pub = fake({
    listings: [remoteOf(dir, 'en-US'), { language: 'de-DE', title: 'Alt' }],
    images: {
      'en-US/phoneScreenshots': [{ sha256: sha('p1') }, { sha256: sha('zzz') }],
      'en-US/icon': [{ sha256: sha('icon') }],
    },
  });
  assert.equal(await run(args(dir, ['--apply']), deps(pub)), 0);
  const updates = pub.calls.filter((c) => c.startsWith('listings.update'));
  assert.ok(updates.every((c) => c !== 'listings.update:en-US'));
  assert.deepEqual(pub.calls.filter((c) => /deleteall|upload/.test(c)), ['deleteall:phoneScreenshots', 'upload:phoneScreenshots', 'upload:phoneScreenshots']);
  assert.deepEqual(pub.calls.slice(-2), ['validate', 'commit']);
  assert.ok(!pub.calls.includes('delete'));
});

test('failure mid-way deletes the edit and does not commit', async () => {
  const dir = setup();
  const pub = fake({ listings: [], failOn: 'upload' });
  const errs = [];
  assert.equal(await run(args(dir, ['--apply']), deps(pub, { err: (m) => errs.push(m) })), 1);
  assert.ok(pub.calls.includes('delete'));
  assert.ok(!pub.calls.includes('commit'));
  assert.match(errs.join('\n'), /rejected the request/);
});

test('Console-only locale is reported, never deleted', async () => {
  const dir = setup();
  const logs = [];
  const pub = fake({ listings: [{ language: 'fr-FR', title: 'x' }] });
  await run(args(dir, ['--apply']), deps(pub, { log: (m) => logs.push(m) }));
  assert.match(logs.join('\n'), /fr-FR: in Play Console only, left untouched/);
  assert.ok(!pub.calls.some((c) => c.includes('fr-FR')));
});

test('validator errors refuse before any API call', async () => {
  const dir = setup();
  let called = false;
  const bad = () => ({ ok: false, errors: [{ file: 'f', message: 'bad' }], warnings: [] });
  const pub = fake();
  assert.equal(await run(args(dir), deps(pub, { getPublisher: async () => { called = true; return pub; }, checkImages: bad })), 1);
  assert.equal(called, false);
  assert.deepEqual(pub.calls, []);
  assert.equal(await run(args(dir, ['--text-only']), deps(pub, { checkListing: bad })), 1);
  assert.deepEqual(pub.calls, []);
});

test('--text-only skips image checks and image calls', async () => {
  const dir = setup();
  const pub = fake();
  const boom = () => { throw new Error('should not run'); };
  assert.equal(await run(args(dir, ['--text-only', '--apply']), deps(pub, { checkImages: boom })), 0);
  assert.ok(!pub.calls.some((c) => /upload|deleteall/.test(c)));
});

test('real checkListing accepts the fixture used here', () => {
  assert.equal(checkListing(valid).ok, true);
});

test('screenshots upload in numeric file order', async () => {
  const dir = setup();
  const d = join(dir, 'en-US', 'images', 'phoneScreenshots');
  writeFileSync(join(d, '10.png'), 'p10');
  const bodies = [];
  const pub = fake();
  const up = pub.edits.images.upload;
  pub.edits.images.upload = async (p) => { if (p.imageType === 'phoneScreenshots') bodies.push(p.media.body.path); return up(p); };
  await run(args(dir, ['--apply']), deps(pub));
  assert.deepEqual(bodies.map((b) => b.split('/').pop()), ['1.png', '2.png', '10.png']);
});

test('field on Play with no local file is kept and reported', async () => {
  const dir = setup();
  const logs = [];
  const pub = fake({ listings: [{ ...remoteOf(dir, 'en-US'), title: 'Old', video: 'https://youtu.be/x' }] });
  await run(args(dir, ['--text-only']), deps(pub, { log: (m) => logs.push(m) }));
  assert.match(logs.join('\n'), /en-US: video: on Play, no local file — kept/);
});

test('flag values starting with -- are rejected', async () => {
  const pub = fake();
  const errs = [];
  assert.equal(await run(['--package', 'p', '--default', '--apply', valid], deps(pub, { err: (m) => errs.push(m) })), 2);
  assert.deepEqual(pub.calls, []);
});

test('no "edit discarded" message when no edit was created', async () => {
  const dir = setup();
  const pub = fake();
  pub.edits.insert = async () => { throw Object.assign(new Error('nope'), { code: 403 }); };
  const errs = [];
  assert.equal(await run(args(dir, ['--apply']), deps(pub, { err: (m) => errs.push(m) })), 1);
  assert.doesNotMatch(errs.join('\n'), /discarded/);
});

test('both icon.png and icon.jpg warns', async () => {
  const dir = setup();
  writeFileSync(join(dir, 'en-US', 'images', 'icon.jpg'), 'j');
  const errs = [];
  await run(args(dir), deps(fake(), { err: (m) => errs.push(m) }));
  assert.match(errs.join('\n'), /warning: en-US: icon exists in several formats/);
});

test('withEdit: commit throws -> edit deleted, original error', async () => {
  const pub = fake({ failOn: 'commit' });
  await assert.rejects(withEdit(pub, 'p', async () => {}, { commit: true }), /boom/);
  assert.ok(pub.calls.includes('delete'));
});

test('withEdit: delete failing after an error keeps the original error', async () => {
  const pub = fake();
  pub.edits.delete = async () => { throw new Error('delete failed'); };
  await assert.rejects(withEdit(pub, 'p', async () => { throw new Error('orig'); }), /orig/);
});

test('withEdit: failing cleanup delete after a good dry run is ignored', async () => {
  const pub = fake();
  pub.edits.delete = async () => { throw new Error('delete failed'); };
  assert.equal(await withEdit(pub, 'p', async () => 42), 42);
});

test('explainApiError: no status -> bare message; ENOENT is not a status', () => {
  assert.equal(explainApiError(Object.assign(new Error('socket hang up'), { code: 'ENOENT' }), 'p'), 'socket hang up');
  assert.match(explainApiError({ code: 403, message: 'API has not been used in project 1' }, 'p'), /not enabled.*setup.md step 1/);
});

test('new locale: no images.list, reports uploads; apply creates listing before upload', async () => {
  const dir = setup();
  const pub = fake({ listings: [] });
  const listed = [];
  pub.edits.images.list = async (p) => { listed.push(p.language); return { data: { images: [] } }; };
  const logs = [];
  await run(args(dir, ['--apply']), deps(pub, { log: (m) => logs.push(m) }));
  assert.deepEqual(listed, []);
  assert.match(logs.join('\n'), /en-US: phoneScreenshots: replace \(0 on Play -> 2 local\)/);
  const i = pub.calls.indexOf('listings.update:en-US');
  const j = pub.calls.indexOf('upload:phoneScreenshots');
  assert.ok(i >= 0 && i < j);
  assert.ok(!pub.calls.includes('deleteall:phoneScreenshots'));
});

test('images.list 404 for an existing locale is tolerated', async () => {
  const dir = setup();
  const pub = fake({ listings: [remoteOf(dir, 'en-US')] });
  pub.edits.images.list = async () => { throw Object.assign(new Error("Listing for language 'en-US' not found"), { code: 404 }); };
  assert.equal(await run(args(dir), deps(pub)), 0);
});

test('explainApiError: listing 404 is not blamed on the package name', () => {
  const m = explainApiError({ code: 404, message: "Listing for language 'de-DE' not found" }, 'p');
  assert.match(m, /locale listing does not exist/);
  assert.match(explainApiError({ code: 404, message: 'Package not found' }, 'p'), /package name/);
});
