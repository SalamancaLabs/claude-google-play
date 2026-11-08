# claude-google-play

A Claude Code plugin, `google-play`, that fills in your app's Google Play Console
declarations and store listing from evidence in your app's repo.

It never guesses. Every answer must cite a source. Anything it can't back up
stops the run and goes to you for review.

> **Status:** in development.

## Skills

### `/google-play:app-content`

Covers the Console's **App content** section: content rating, target audience,
ads, app access, Data safety, and the other declarations.

1. **Draft.** Reads your app repo (manifest, dependencies, network code,
   privacy policy URL, linked tickets) and writes `play/app-content.yaml`.
   Each answer has a value, evidence, and a status (`confirmed` or `needs_review`).
2. **Review.** You resolve every `needs_review` answer in the YAML and commit it.
   The YAML is the record of why each answer was given.
3. **Apply.**
   - **Data safety** is converted to Google's CSV format and pushed through the
     official `applications.dataSafety` API.
   - **All other sections** are filled in the Play Console with the Playwright MCP.
     For each section you see what changes compared with the current Console
     values, and nothing is saved until you approve.

A read-only `verify` run compares the live Console answers with the YAML and
reports every mismatch.

### `/google-play:store-listing`

Covers the store listing for every locale your app ships.

1. **Draft.** Writes the title, short description and full description for each
   locale into `fastlane/metadata/android/<locale>/`. Product claims must match
   features in the repo, and Play's length limits are enforced.
2. **Screenshots.** Captures them from the running app, for each locale and
   device type.
3. **Push.** Shows a diff against the current listing, then uploads text and
   images through the Play Developer API in a single edit.

Run either skill in Claude Code from the app's repo.

## Requirements

- Claude Code
- Node.js (for the Playwright MCP)
- A Google Play Console account with access to the app
- A Play service account with the Android Publisher API enabled (used for
  Data safety and the store listing)

## Install

In Claude Code:

    /plugin marketplace add SalamancaLabs/claude-google-play
    /plugin install google-play@claude-google-play

Then follow [docs/setup.md](docs/setup.md) for the service account key and the
one-time Play Console login.
