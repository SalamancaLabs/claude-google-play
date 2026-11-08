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
3. **Apply** (Data safety via the `applications.dataSafety` API; other sections via the Playwright MCP, with owner approval before saving) - Not implemented yet.

A separate read-only **Verify** run compares the live Console answers with the YAML - Not implemented yet.
