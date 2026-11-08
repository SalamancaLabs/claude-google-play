---
name: store-listing
description: Use when the user wants to draft store listing text per locale, capture screenshots, or push the Google Play store listing for the app in the current repo.
---

# store-listing

Drafts listing text per locale into `fastlane/metadata/android/<locale>/`, captures screenshots, and pushes the listing through the Play Developer API.

## Phases

1. **Draft** - see below.
2. **Screenshots** - Not implemented yet.
3. **Push** - Not implemented yet.

## Draft

Writes `fastlane/metadata/android/<locale>/` with `title.txt`, `short_description.txt`, `full_description.txt` and, optionally, `video.txt` (a YouTube URL), for the default language and every app locale. The same files serve review, an API push and CI.

1. **Ask the owner for the default language.** Do not guess it.
2. **Find the app locales** in the repo: Flutter `l10n.yaml` plus `.arb` files, Android `res/values-<qualifier>/strings.xml`, or other i18n files. Map each to a Play locale code, for example `de` to `de-DE`, `pt_BR` or `pt-rBR` to `pt-BR`, `es` to `es-ES`, `en` to `en-US`. The valid codes are in `PLAY_LOCALES` in `${CLAUDE_PLUGIN_ROOT}/scripts/check-listing.mjs`. When a mapping is ambiguous (`es`, `pt`, `zh`, `en`), ask the owner. Show the final locale list before drafting.
3. **Read the repo for features** (README, manifest, screens, strings, dependencies). Draft the default-language text first, then the other locales.
4. **Limits:** title 30, short description 80, full description 4000 characters. Title: no emoji, no ALL CAPS unless a brand name, no ranking, price or promotional words. Follow Play's Metadata policy: https://support.google.com/googleplay/android-developer/answer/9898842
5. **Evidence rule.** Every product claim in the text must match a feature in the repo. In the chat summary, list each claim with its evidence (file path or owner statement). Leave out claims without evidence, or flag them for the owner. Never invent features, ratings, user counts or awards.
6. **Translations** keep the same meaning in every locale. Give a one-line back-translation per locale for the owner to review.
7. **Existing files.** Never overwrite existing listing files without showing the diff and getting approval. Update only what the owner asked for.
8. **Check.** From the app repo root, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-listing.mjs" fastlane/metadata/android --default <owner's default locale>` and fix every error. Report warnings to the owner.
