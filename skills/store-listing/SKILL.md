---
name: store-listing
description: Use when the user wants to draft store listing text per locale, capture screenshots, or push the Google Play store listing for the app in the current repo.
---

# store-listing

Drafts listing text per locale into `fastlane/metadata/android/<locale>/`, captures screenshots, and pushes the listing through the Play Developer API.

## Phases

1. **Draft** - see below.
2. **Screenshots** - see below.
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

## Screenshots

Generates screenshots from the app itself into `fastlane/metadata/android/<locale>/images/<deviceType>Screenshots/`, then validates them.

1. **Ask the owner** which screens to show (2 to 8) and in what order. Phone is required. Add 7-inch (`sevenInchScreenshots`) and 10-inch (`tenInchScreenshots`) only if the app supports tablets: check the manifest (`supports-screens`, `resizeableActivity`, tablet layouts) or ask. `tvScreenshots` and `wearScreenshots` only for TV or Wear OS apps.
2. **Reuse the app's existing test harness; do not build a second one.**
   - Flutter: an `integration_test` that drives seeded demo data through the chosen screens and captures one image per screen and locale with `IntegrationTestWidgetsFlutterBinding.takeScreenshot`. Run it on an emulator per device size. If the app already has golden or widget tests that render at device sizes, reuse those instead.
   - Native Android: instrumented tests with the app's screenshot helper, or UiAutomator `takeScreenshot`.
   - Loop over the app locales found in the Draft phase; set the app locale in the test, not the device.
3. **Demo data:** deterministic and seeded, with no personal data (names, emails, photos, real locations). Same data in every locale unless the content is itself localized.
4. **Clean status bar** when capturing on an emulator, using Android demo mode:
   ```
   adb shell settings put global sysui_demo_allowed 1
   adb shell am broadcast -a com.android.systemui.demo -e command enter
   adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200
   adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
   adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4
   adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
   ```
   Leave demo mode afterwards with `-e command exit`.
5. **Output:** one folder per device type, files named `1_<screen>.png`, `2_<screen>.png`, ... so the order is the upload order. Use JPEG or 24-bit PNG without alpha (convert RGBA captures), each side 320 to 3840 px, longer side at most 2x the shorter, at most 8 per device type. Prefer 1080x1920 or larger portrait for phones. Requirements: https://support.google.com/googleplay/android-developer/answer/9866151
6. **Feature graphic (1024x500) and icon (512x512, 32-bit PNG, at most 1 MB)** as `featureGraphic.png` and `icon.png` in `images/`. Create them only when missing, and only from art the owner provides. Never invent branding.
7. **Existing files.** Never overwrite existing images without the owner's approval.
8. **Check.** From the app repo root, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-images.mjs" fastlane/metadata/android --default <owner's default locale>` and fix every error. Report warnings to the owner (for example a locale missing a device type that the default locale has).
