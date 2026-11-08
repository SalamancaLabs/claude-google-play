# Setup

You do this once per machine. Step 2 also needs doing once for each app.

## 1. Service account key

The API steps (Data safety and the store listing) authenticate with a Play
service account. Keep its key outside any repo, readable only by you:

    mkdir -p ~/keys && chmod 700 ~/keys
    mv path/to/play-service-account.json ~/keys/
    chmod 600 ~/keys/play-service-account.json

Before the key works, enable the **Google Play Android Developer API** in the
Google Cloud project that owns the service account (APIs & Services →
Library). Until it is enabled, calls fail with a 403 "API has not been used in
project … or it is disabled".

Point the plugin at it. Add this to your shell profile so every session has it:

    export GOOGLE_APPLICATION_CREDENTIALS=~/keys/play-service-account.json

Never commit the key. This repo is public, and so may be your app's repo.

## 2. Give the service account access to the app

In Play Console → **Users and permissions**, invite the service account's
email and grant it access to the app, with permission to manage the store
presence. Without this, API calls fail with a permission error even when the
key is valid.

## 3. Sign in to the Play Console once

The browser steps use the plugin's `google-play-browser` MCP server (Playwright
MCP), with a dedicated browser profile at `~/.local/share/google-play/profile`,
separate from your everyday browser. The plugin starts it for you, and it needs
Node.js with `npx`. It drives Google Chrome by default. If Chrome is missing,
install it with `npx playwright install chrome`, or with your distro's Chrome
package.

1. Run `/google-play:app-content` once. The first browser step opens a browser
   window and loads the Play Console.
2. Sign in to your Google account by hand, including 2FA.
3. Set the Play Console language to **English**. The skill finds forms by
   their English labels and checks the language before it fills anything.

Later runs reuse that session. When it expires, the skill stops and asks you to
sign in again. It never types your credentials.

## 4. Check it works

From your app's repo, run `/google-play:app-content` to draft
`play/app-content.yaml`, then ask for a `verify` run. It reads the Console
without changing anything and reports every answer that differs from the YAML.
If your app's App content is already filled in, this is a safe first test.
