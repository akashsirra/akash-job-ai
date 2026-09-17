# ApplyPilot Firefox Android MVP

ApplyPilot is a browser-side job application assistant. It reads the current page, detects application fields, fills factual profile fields, and can generate answers for eligible open-ended questions using Groq.

## Install for development

1. Open the `extension/` directory from this branch on a desktop Firefox installation and load it as a temporary add-on from `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `manifest.json`.
2. For Firefox Android, use a Firefox-compatible extension distribution/install flow supported by your Firefox version. Android support and install restrictions can vary by release.
3. Open ApplyPilot settings and add your Groq API key and profile.
4. Open a job application page and use the ApplyPilot button.

## MVP behavior

- Scans visible `input`, `textarea`, and `select` fields.
- Maps common identity/contact/education fields from the saved profile.
- Generates answers for eligible open-ended fields with Groq.
- Skips passwords, OTPs, CAPTCHAs, financial/identity verification fields, and file uploads.
- Does not click a final Submit/Apply button.

## Groq key

The MVP stores the key in Firefox extension storage for a private development install. Do **not** publish a build that contains a shared API key. A production release should move Groq calls behind an authenticated backend.

## No Browserbase dependency

The extension itself runs in the user's browser and does not use Browserbase. The older repository automation scripts remain separate and are not required by the extension.
