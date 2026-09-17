# FreeBrowser application runner

`npm run apply` uses the Android FreeBrowser local API instead of Browserbase for application preparation.

Flow:
1. Select the highest-scoring eligible, live queued job.
2. Open the posting in FreeBrowser.
3. Detect an application route when possible.
4. Click Apply when needed.
5. Inspect and fill only fields that can be mapped from `profile.json`.
6. Never invent answers and never fill passwords, OTPs, CAPTCHA/security codes, signatures, or file uploads automatically.
7. Advance through application steps when a clear Next/Continue control exists.
8. Stop at the final submission control and leave it for explicit human confirmation.
9. Write `application-draft.json` with the filled/skipped fields and current URL.

FreeBrowser must be running on the Android device at `http://127.0.0.1:8765`.

No per-job curl commands are required. The runner talks to FreeBrowser directly.
