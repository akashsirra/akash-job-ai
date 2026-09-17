# Akash Job AI

Browserbase-powered job discovery and application-preparation workflow for Akash's fresher software-engineering search.

## What it does

1. **Discover** fresh job links from Google using one Browserbase session.
2. **Verify** one posting at a time and save the resolved official application URL.
3. **Match** jobs against the local profile and job rules without an LLM.
4. **Prepare** known application fields in the browser and record unknown required fields.
5. **Stop before final submission.** The agent never invents answers or submits an application automatically.

## Setup

```bash
npm install
cp profile.example.json profile.json
# edit profile.json with your real information
```

Create `.env` locally:

```text
BROWSERBASE_API_KEY=your_key
BROWSERBASE_PROJECT_ID=your_project_id
```

`.env`, `profile.json`, and `application-draft.json` are intentionally ignored by Git.

## Commands

```bash
npm run status
npm run discover
npm run verify
npm run match
npm run prepare
```

`npm run discover`, `npm run verify`, and `npm run prepare` each use at most one Browserbase session per invocation. Matching is local and uses no Browserbase session.

## Workflow

```text
Google discovery
      ↓
job-queue.json
      ↓
verify one posting
      ↓
official application URL
      ↓
profile/rules matcher
      ↓
application preparation
      ↓
human review
      ↓
manual final submission
```

## Safety rules

- Never expose API keys in the repository.
- Never invent resume/application information.
- Unknown required questions are reported instead of guessed.
- CAPTCHA, MFA, passwords, and verification codes are never automated.
- Final application submission is never automated.
- Browserbase is used one candidate at a time to control session usage.

## Local data

The public repository contains only the application code, rules, and safe templates. Your real `profile.json` remains local.
