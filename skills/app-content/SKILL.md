---
name: app-content
description: Use when the user wants to draft, verify, or apply the Google Play Console App content declarations (content rating, target audience, ads, app access, Data safety) for the app in the current repo.
---

# app-content

Drafts `play/app-content.yaml` from the app repo, then verifies and applies the Play Console App content declarations. Every answer carries a value, evidence, and a status (`confirmed` or `needs_review`).

## Browser preflight

Every browser step runs this first, using the `google-play-browser` MCP server (Playwright, persistent profile, headed). Stop at the first failed check.

1. Open `https://play.google.com/console`.
2. If the page redirects to `accounts.google.com`, shows a sign-in page, a "Verify it's you" prompt, or a CAPTCHA: STOP. Ask the owner to sign in by hand in the opened browser window, then retry. Never type credentials and never fill sign-in forms.
3. Confirm the Console UI is in English: the page `lang` attribute is `en` or English navigation labels such as "App content" are present. If not, STOP and tell the owner to switch the language (Play Console Settings → Preferences, or the Google account language).
4. Confirm the developer account and app name match what the owner expects. If you do not know them, ask. STOP on a mismatch.

## Draft

Never touches the Play Console. Reads the app repo, writes `play/app-content.yaml`, validates it. Needs no browser.

1. **Scan.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-app.mjs" <repoDir>` (`<repoDir>` = the app repo root). It prints JSON facts, each with the file (and line) it came from: manifest permissions and `tools:node="remove"` removals (debug/profile manifests listed apart from `main`), dependencies (pubspec `dependencies`, Gradle, `package.json`; dev/test-only ones are listed apart in `dependencies.excluded` and never count as shipped), network hosts, privacy policy URL candidates, locale hints, app identity.
2. **Identity.** `package_name` from the Gradle `applicationId` (else ask the owner); `app_name` from the manifest `label` or the owner. If either is unknown, ask. Do not invent.
3. **Map facts to answers** using `${CLAUDE_PLUGIN_ROOT}/skills/app-content/sdk-catalog.yaml`. Match each declared dependency name against the catalog `packages` (pub / maven / npm). Matches in `main` code only; ignore `debugImplementation`-style configurations and debug/profile manifests for release answers, and say so in `note`.
   - Catalog match: set the entry's `data` types to `collected: true`. Copy `shared`, `required`, `ephemeral` only if the catalog states them. Map the catalog `collection_purposes` to the schema field `collection_purposes` on each collected data type, and `sharing_purposes` to the schema field `sharing_purposes` (only when `shared: true`). Where the catalog states none, leave the answer `needs_review` and ask the missing question (for example "Is Crashlytics data shared with anyone besides Google?"). Cite `dependency: <name>@<version>` and put the catalog `source` URL in `note`. `depends_on_usage` types are always `needs_review`: ask whether the app's configuration or code sends them. An entry with `needs_review_only: true` confirms nothing: every related answer stays `needs_review`.
   - Declared-only dependencies: a scanner dependency with `declared_only: true` (in `libs.versions.toml` but never referenced from a Gradle file) is "declared, may be unused". Keep its answers `needs_review` and ask whether it ships.
   - BOM-managed versions: when a Gradle dependency has `version: null` and `managed_by`, cite it as `dependency: <name> (version managed by <managed_by>)`. If `managed_by` is absent, cite `dependency: <name>@unversioned` and say why in `note`.
   - Dependency not in the catalog: it may collect data. Mark `collects_or_shares_user_data` as `needs_review` and list the unknown packages in the question. Do not guess what an unknown SDK does.
   - Advertising ID. Source manifests are not the merged manifest: library manifests add permissions and `tools:node="remove"` may be overridden. Whenever any matched catalog entry has `uses_advertising_id: true` (ad SDKs and analytics SDKs such as Firebase Analytics), and before confirming any permission-based answer, inspect the merged release manifest: `build/app/intermediates/merged_manifests/release/**/AndroidManifest.xml`, or, if the owner agrees, produce it with `./gradlew :app:processReleaseManifest` (or `flutter build apk --release`). If it is unavailable, set the answer `needs_review` with that reason. `advertising_id.uses_advertising_id` is true if `com.google.android.gms.permission.AD_ID` is in the merged manifest; false only if it is absent there AND the owner confirms no SDK uses the ID in another way (cite the merged manifest path:line).
   - Ad SDK in catalog (`ads: true`): `ads.contains_ads` true, evidence `dependency`.
   - Manifest permissions: `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`, `CAMERA`, `RECORD_AUDIO`, `READ_CONTACTS`, `READ_CALENDAR`, `READ_SMS`, and similar imply the app may handle that data type. A permission present means `needs_review` ("Is this data collected or only processed on device?"), never auto `collected: true`.
   - Privacy policy: use a `privacy_policy_candidates` URL. Several candidates, or a source other than the README/fastlane metadata: `needs_review` listing them. Must be `https://`.
   - Network hosts are context for the owner's questions (what leaves the device); they never prove a data type on their own.
4. **Evidence rules.** Every answer needs a status. `confirmed` answers must cite at least one item:
   - `file:` repo-relative path, optionally `path:line`. The file must exist.
   - `dependency:` `name@version` as declared. The dependency must be declared.
   - `ticket:` only when the owner points to one.
   - `owner:` only for an explicit statement the owner made in this session, quoted.
   Anything else is `needs_review`, `value: null` (or your best guess in `value` when useful), `evidence: []` or what you found, and `question:` written out so the owner can answer it in one line.
5. **Absence rule.** Absence of evidence never confirms a claim Play needs stated positively. This covers every "no ads / no data collected / no login / no purchases / not shared / not collected" answer, including each data type in Data safety set to `collected: false`. Such an answer may be `confirmed` only when (a) the scanner found no dependency, permission or code path that implies the opposite (cite the files you checked, e.g. the manifest and the dependency file) AND (b) the owner confirmed it in this session (add an `owner:` item quoting them). Otherwise `needs_review` with the question "Confirm: does the app ...?". Example: no ad SDK found and the owner says "no ads" -> `contains_ads: false` confirmed with `file: pubspec.yaml` (the dependency list checked) plus `owner:`. No owner answer -> `needs_review`.
6. **Owner decisions.** `content_rating` (category and each questionnaire answer), `target_audience`, `news_app`, `government_app`, `financial_features`, `health_apps` are decisions, not facts. Always `needs_review` with a concrete question unless the owner already answered. Examples: "Which age groups is the app aimed at?", "Does it show user-generated content or let users interact?", "Does the app offer any health feature (medication, sleep, symptoms)?". `app_access`: `needs_review` unless the owner says whether any feature needs a login (the scanner cannot tell). `security.encrypted_in_transit`: `needs_review` unless `network_hosts` are all `https` AND the owner confirms; `deletion_request_mechanism`: ask the owner.
7. **Re-run (file already exists).** Read `play/app-content.yaml` first.
   - Keep every answer the owner resolved (status `confirmed` with an `owner:` item) as is. Do not overwrite it.
   - For each other `confirmed` answer, re-check its evidence: `file:` still exists (and the cited line still holds the same content if you cited a line); `dependency:` still declared at that version. If any item fails, set `status: needs_review` and put the reason in `question` (e.g. "dependency firebase_analytics no longer declared; still collects analytics?"). Never silently drop evidence.
   - New facts (a new dependency not in the file): add or downgrade the affected answers to `needs_review`.
   - Keep `needs_review` answers the owner has not touched; update their `question` if the scan changed it.
8. **Write and validate.** Write `play/app-content.yaml` (create `play/` if needed) in the shape of `${CLAUDE_PLUGIN_ROOT}/examples/app-content.example.yaml`. All `sections` keys and all Data safety data types are required by the schema: fill the full set. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" play/app-content.yaml`. Fix every error and re-run until it exits 0.
9. **Summary.** End with `N confirmed, M needs review` (the validator prints these counts) and a numbered list of every open question with its YAML path. Tell the owner to resolve them in the Review phase.

## Review

The owner resolves each `needs_review` answer; Claude records it. Nothing is applied to the Console in this phase.

1. Show the open questions from the Draft summary (or re-list them from the YAML), grouped by section.
2. For each answer the owner gives, update that leaf: set `value`, set `status: confirmed`, remove `question`, and add an evidence item `owner:` quoting their statement as they gave it (keep any file/dependency evidence already there). Do not paraphrase their words into something stronger than they said. If the owner is unsure, leave it `needs_review` and refine the question.
3. If the owner's answer needs facts not in the repo (a ticket, a policy page), add `ticket:` only if they point to one.
4. Re-run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" play/app-content.yaml`, fix errors, and print the new `N confirmed, M needs review` line.
5. Ask the owner to commit `play/app-content.yaml`. Apply refuses to run while any `needs_review` remains outside `data_safety`.

## Phases

1. **Draft** - See the Draft section above.
2. **Review** - See the Review section above.
3. **Apply** - see [Apply](#apply) below.

A separate read-only **Verify** run compares the live Console answers with the YAML - Not implemented yet.

## Apply

Fills every App content section except Data safety in the Console from `play/app-content.yaml`, through the `google-play-browser` MCP server. Navigation, labels and value mappings live in `${CLAUDE_PLUGIN_ROOT}/skills/app-content/console-map.yaml`. Data safety is out of scope here: it goes through the Data safety API script, not the browser.

### Gate

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" play/app-content.yaml`. If it fails, STOP and show the errors.
2. If any answer outside `data_safety` has `status: needs_review`, STOP and list those keys. The owner resolves them in the Review phase first.
3. Run the Browser preflight above. Stop at the first failed check.

### Per section

Go through the sections of `console-map.yaml` in order. For each one:

1. Navigate: Policy and programs → App content → the section's `card`, then click whichever `open_button` entry is shown.
2. Read the current Console values for every question of the section, without changing anything.
3. Show the owner a table: YAML key | exact on-screen question and option text, quoted from the browser snapshot | Console now | YAML answer | change? Every map label is `verified: false`, so match by meaning, and quote what is really on screen next to the key. The owner's approval covers that pairing. If no on-screen question plausibly matches a key, or more than one does, treat it as "label not found" below.
4. If nothing changes, report the section as unchanged and move on. Do not click Save.
5. Otherwise fill only the controls that change, using the `map` rules. Find each control by its visible English label and ARIA role in the browser snapshot. Never use CSS classes, element ids, or coordinates. Never type credentials or fill sign-in forms; `access_instructions` text comes from the YAML as written.
   Before approval, click only Next and Back inside a form. Never click "Save draft" or "Save as draft" (content rating, financial features and health apps have them), and never click Discard.
6. Ask the owner for explicit approval of the filled form. Only after a clear yes, click the section's `save_button` (Save, Submit, or the last Next-then-Save step of a wizard). Wait for the confirmation, then re-read the values to check they stuck.

### Content rating

Walk the whole questionnaire with Next and Back, filling nothing it already shows correctly, and collect ALL IARC questions into one approval table. Do not submit page by page. Stop the section when a Console question has no YAML key, or when a YAML questionnaire key matches no Console question. Never retake: if only "Start new questionnaire" is offered or a retake dialog appears, stop, leave it unsaved, and report.

### Never do

Never open Publishing overview. Never click "Send for review", "Send changes for review" or "Publish". Saving a section is the only change you make; the owner sends changes for review themselves.

### Stop on the section (do not guess) when

- no on-screen question plausibly matches a map entry, or more than one does (label not found),
- the form shows a question the YAML or the map does not cover,
- a control has a different type than the map says,
- a confirmation dialog appears that is not a plain save (for example discard, retake, or a policy warning).

Leave the section unsaved, report exactly what you saw (label text, role, dialog text), and go on to the next section. When a label differs from the map, tell the owner that `console-map.yaml` needs updating. Do not adapt silently.

### Report

End with one line per section: `filled`, `unchanged`, or `blocked (reason)`. Add a final line for Data safety: not handled here, use the Data safety script.
