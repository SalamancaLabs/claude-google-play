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

## Phases

1. **Draft** - Not implemented yet.
2. **Review** - Not implemented yet.
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
