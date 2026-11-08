---
name: app-content
description: Use when the user wants to draft, verify, or apply the Google Play Console App content declarations (content rating, target audience, ads, app access, Data safety) for the app in the current repo.
---

# app-content

Drafts `play/app-content.yaml` from the app repo, then verifies and applies the Play Console App content declarations. Every answer carries a value, evidence, and a status (`confirmed` or `needs_review`).

## Phases

1. **Draft** - Not implemented yet.
2. **Review** - Not implemented yet.
3. **Apply** (Data safety via the `applications.dataSafety` API; other sections via the Playwright MCP, with owner approval before saving) - Not implemented yet.

A separate read-only **Verify** run compares the live Console answers with the YAML - Not implemented yet.
