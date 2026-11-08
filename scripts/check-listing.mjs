#!/usr/bin/env node
// Checks fastlane-layout Play store listing text: fastlane/metadata/android/<locale>/*.txt
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Google Play listing languages (Play Console "Translate & localize your app").
// Source: https://support.google.com/googleplay/android-developer/answer/9844778
export const PLAY_LOCALES = new Set(
  `af sq am ar hy-AM az-AZ bn-BD eu-ES be bg my-MM ca zh-HK zh-CN zh-TW hr cs-CZ da-DK nl-NL
en-AU en-CA en-US en-GB en-IN en-SG en-ZA et fil fi-FI fr-CA fr-FR gl-ES ka-GE de-DE el-GR gu
iw-IL hi-IN hu-HU is-IS id it-IT ja-JP kn-IN kk km-KH ko-KR ky-KG lo-LA lv lt mk-MK ms-MY ms
ml-IN mr-IN mn-MN ne-NP no-NO fa fa-AE fa-AF fa-IR pl-PL pt-BR pt-PT pa ro rm ru-RU sr si-LK sk
sl es-419 es-ES es-US sw sv-SE ta-IN te-IN th tr-TR uk ur vi`.split(/\s+/),
);

export const LIMITS = { 'title.txt': 30, 'short_description.txt': 80, 'full_description.txt': 4000 };
export const REQUIRED = Object.keys(LIMITS);
const OPTIONAL = ['video.txt'];

// Play "Metadata" policy: https://support.google.com/googleplay/android-developer/answer/9898842
// - Title: 30 characters max. No emoji, emoticons or repeated special characters in title.
// - Avoid ALL CAPS unless part of the brand name.
// - No performance/ranking text ("App of the year", "#1", "Best of Play 20XX", "Popular"),
//   price/promo text ("10% off", "$50 cash back", "free for limited time only"),
//   or Google Play program text ("Editor's choice", "New").
// The policy does not name "best", "top", "sale", "discount" or "no ads"; they are included as
// common promotional/performance claims and only warn.
const PROMO = [
  '#\\s?1', 'best', 'top', 'popular', 'free', 'new', 'sale', 'discount', 'no ads', 'ad[- ]free',
  'app of the year', "editor'?s choice", 'award[- ]winning', '\\d+\\s?% off', 'cash back',
  'limited time', 'best of play',
];
const PROMO_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PROMO.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const CAPS_WORD_RE = /(?<![\p{L}\p{N}])\p{Lu}{3,}(?![\p{L}\p{N}])/u;

const read = (p) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '').normalize('NFC').replace(/\r?\n$/, '');
const len = (s) => [...s].length;

export function checkListing(dir = 'fastlane/metadata/android', { defaultLocale } = {}) {
  const errors = [];
  const warnings = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, errors: [{ file: dir, message: 'listing directory not found' }], warnings };
  }
  const locales = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (!locales.length) errors.push({ file: dir, message: 'no locale directories found' });

  const files = (l) => new Set(readdirSync(join(dir, l)));
  let defaultFiles = null;
  if (defaultLocale) {
    if (locales.includes(defaultLocale)) defaultFiles = files(defaultLocale);
    else errors.push({ file: join(dir, defaultLocale), message: `default locale "${defaultLocale}" has no directory` });
  }

  for (const locale of locales) {
    const ldir = join(dir, locale);
    if (!PLAY_LOCALES.has(locale)) {
      errors.push({ file: ldir, message: `"${locale}" is not a Google Play listing locale code` });
    }
    const present = files(locale);
    for (const name of REQUIRED) {
      const f = join(ldir, name);
      if (!present.has(name)) {
        errors.push({ file: f, message: 'required file missing' });
        continue;
      }
      const text = read(f);
      if (!text.trim()) {
        errors.push({ file: f, message: 'file is empty' });
        continue;
      }
      const n = len(text);
      if (n > LIMITS[name]) errors.push({ file: f, message: `${n} characters, limit is ${LIMITS[name]}` });
      if (name === 'title.txt') {
        if (EMOJI_RE.test(text)) errors.push({ file: f, message: 'emoji not allowed in title (Play Metadata policy)' });
        const caps = text.match(CAPS_WORD_RE);
        if (caps) warnings.push({ file: f, message: `ALL-CAPS word "${caps[0]}" in title; allowed only for brand names` });
      }
      if (name === 'title.txt' || name === 'short_description.txt') {
        const m = text.match(PROMO_RE);
        if (m) warnings.push({ file: f, message: `promotional/performance term "${m[0]}" (Play Metadata policy)` });
      }
    }
    if (defaultFiles && locale !== defaultLocale) {
      // Missing required files are already errors; warn for optional ones.
      for (const name of OPTIONAL) {
        if (defaultFiles.has(name) && !present.has(name)) {
          warnings.push({ file: join(ldir, name), message: `missing; ${defaultLocale} has it` });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--default');
  const defaultLocale = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const dir = args[0] ?? 'fastlane/metadata/android';
  const r = checkListing(dir, { defaultLocale });
  for (const e of r.errors) console.error(`error: ${e.file}: ${e.message}`);
  for (const w of r.warnings) console.warn(`warning: ${w.file}: ${w.message}`);
  console.log(r.ok ? 'listing ok' : `listing has ${r.errors.length} error(s)`);
  process.exit(r.ok ? 0 : 1);
}
