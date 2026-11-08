#!/usr/bin/env node
// Pushes fastlane-layout listing text and images to Google Play via the Play Developer API.
// Dry run by default; --apply commits. Never deletes a locale listing.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkListing as realCheckListing } from './check-listing.mjs';
import { explainApiError, getPublisher as realGetPublisher, withEdit } from './lib/play-client.mjs';

export const IMAGE_TYPES = [
  'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots', 'wearScreenshots',
  'featureGraphic', 'icon',
];
const SINGLE = new Set(['featureGraphic', 'icon']);
const TEXT_FIELDS = [
  ['title', 'title.txt'], ['shortDescription', 'short_description.txt'],
  ['fullDescription', 'full_description.txt'], ['video', 'video.txt'],
];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const readText = (p) => readFileSync(p, 'utf8').replace(/^﻿/, '').normalize('NFC').replace(/\r?\n$/, '');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const clip = (s = '') => { const t = s.replace(/\s+/g, ' '); return t.length > 50 ? `${t.slice(0, 47)}...` : t; };

async function defaultCheckImages(...a) {
  let mod;
  try { mod = await import('./check-images.mjs'); } catch {
    throw new Error('image checker missing: scripts/check-images.mjs not found; use --text-only or update the plugin');
  }
  return mod.checkImages(...a);
}

function parseArgs(argv) {
  const o = { dir: 'fastlane/metadata/android', apply: false, textOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--package') o.pkg = val();
    else if (a === '--default') o.defaultLocale = val();
    else if (a === '--apply') o.apply = true;
    else if (a === '--text-only') o.textOnly = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.dir = a;
  }
  if (!o.pkg) throw new Error('--package <name> is required');
  if (!o.defaultLocale) throw new Error('--default <locale> is required');
  return o;
}

function localListing(dir, locale) {
  const l = {};
  for (const [field, file] of TEXT_FIELDS) {
    const p = join(dir, locale, file);
    if (existsSync(p)) l[field] = readText(p);
  }
  return l;
}

function localImages(dir, locale, type, warn = () => {}) {
  const base = join(dir, locale, 'images');
  let files = [];
  if (SINGLE.has(type)) {
    const found = ['.png', '.jpg', '.jpeg'].map((e) => join(base, type + e)).filter(existsSync);
    if (found.length > 1) warn(`${locale}: ${type} exists in several formats; using ${found[0]}`);
    files = found.slice(0, 1);
  } else if (existsSync(join(base, type))) {
    files = readdirSync(join(base, type)).filter((f) => MIME[extname(f).toLowerCase()]).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => join(base, type, f));
  }
  return files.map((path) => ({ path, sha: sha256(path) }));
}

export async function run(argv, deps = {}) {
  const log = deps.log ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));
  const getPublisher = deps.getPublisher ?? realGetPublisher;
  const checkListing = deps.checkListing ?? realCheckListing;
  const checkImages = deps.checkImages ?? defaultCheckImages;

  let o;
  try { o = parseArgs(argv); } catch (e) { err(`error: ${e.message}`); return 2; }

  let editOpened = false;
  try {
    const checks = [['listing', await checkListing(o.dir, { defaultLocale: o.defaultLocale })]];
    if (!o.textOnly) checks.push(['images', await checkImages(o.dir, { defaultLocale: o.defaultLocale })]);
    let bad = false;
    for (const [name, r] of checks) {
      for (const w of r.warnings ?? []) err(`warning: ${w.file}: ${w.message}`);
      for (const e of r.errors ?? []) { err(`error: ${e.file}: ${e.message}`); bad = true; }
      if (!r.ok) bad = true;
      if (!r.ok) err(`${name} check failed; nothing was sent to Google Play`);
    }
    if (bad) return 1;

    const locales = readdirSync(o.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const publisher = await getPublisher();
    const summary = { textChanged: 0, imageTypesChanged: 0 };

    await withEdit(publisher, o.pkg, async (editId) => {
      editOpened = true;
      const base = { packageName: o.pkg, editId };
      const { data: ld } = await publisher.edits.listings.list(base);
      const remote = new Map((ld?.listings ?? []).map((x) => [x.language, x]));
      const work = [];

      for (const locale of locales) {
        const local = localListing(o.dir, locale);
        const rem = remote.get(locale);
        const changed = TEXT_FIELDS.map(([f]) => f).filter((f) => local[f] !== undefined && local[f] !== (rem?.[f] ?? undefined));
        if (!rem) log(`${locale}: new locale listing`);
        for (const [f] of TEXT_FIELDS) {
          if (local[f] === undefined && rem?.[f]) log(`${locale}: ${f}: on Play, no local file \u2014 kept`);
        }
        for (const f of changed) log(`${locale}: ${f}: "${clip(rem?.[f])}" -> "${clip(local[f])}"`);
        if (changed.length || !rem) {
          summary.textChanged++;
          work.push(async () => publisher.edits.listings.update({
            ...base, language: locale,
            requestBody: { language: locale, ...(rem ?? {}), ...local },
          }));
        } else log(`${locale}: text unchanged`);

        if (o.textOnly) continue;
        for (const type of IMAGE_TYPES) {
          const files = localImages(o.dir, locale, type, (m) => err(`warning: ${m}`));
          if (!files.length) continue;
          const { data: id } = await publisher.edits.images.list({ ...base, language: locale, imageType: type });
          const rimgs = id?.images ?? [];
          const same = rimgs.length === files.length && files.every((f, i) => rimgs[i].sha256 === f.sha);
          if (same) { log(`${locale}: ${type}: unchanged (${files.length})`); continue; }
          log(`${locale}: ${type}: replace (${rimgs.length} on Play -> ${files.length} local)`);
          summary.imageTypesChanged++;
          work.push(async () => {
            await publisher.edits.images.deleteall({ ...base, language: locale, imageType: type });
            for (const f of files) {
              await publisher.edits.images.upload({
                ...base, language: locale, imageType: type,
                media: { mimeType: MIME[extname(f.path).toLowerCase()], body: createReadStream(f.path) },
              });
            }
          });
        }
      }

      const missing = [...remote.keys()].filter((l) => !locales.includes(l)).sort();
      for (const l of missing) log(`${l}: in Play Console only, left untouched (never deleted)`);

      if (o.apply) {
        for (const w of work) await w();
        await publisher.edits.validate(base);
      }
    }, { commit: o.apply });

    const verb = o.apply ? 'applied' : 'dry run (nothing changed; use --apply to push)';
    log(`${verb}: ${summary.textChanged} locale text change(s), ${summary.imageTypesChanged} image set(s) to replace`);
    return 0;
  } catch (e) {
    err(`error: ${explainApiError(e, o.pkg)}`);
    if (o.apply && editOpened) err('The edit was discarded; nothing was committed.');
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
