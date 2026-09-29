# Native Termux browser agent

This branch removes Browserbase from the application-preparation path.

## 1. Install the browser layer

Use Termux on Android:

```bash
pkg update -y
pkg install -y tur-repo x11-repo
pkg install -y firefox xorg-server-xvfb xdotool xclip openbox python
git clone https://github.com/salviz/termux-browser-pilot ~/termux-browser-pilot
cd ~/termux-browser-pilot
bash setup.sh
```

If `tbp` is not on PATH after setup, run the setup shell's PATH instructions or invoke its CLI from the repository.

## 2. Put the job agent on the phone

```bash
git fetch origin
git checkout termux-native-browser-agent
npm install
```

Make sure `profile.json` exists. Never commit it.

## 3. Prove browser control first

```bash
bash termux-browser-doctor.sh
```

Expected result includes:

- PASS: tbp found
- PASS: navigation + page extraction work
- Example Domain

Do not continue if this test fails.

## 4. Run application preparation

```bash
node termux-browser-agent.js
```

Or select a specific queued job:

```bash
node termux-browser-agent.js --job="company role"
```

The agent can navigate, inspect forms, fill only values present in `profile.json`, and advance through unambiguous Next/Continue controls.

It will NEVER automatically fill passwords, OTPs, CAPTCHA/security codes, resume uploads, cover letters, signatures, or unknown required questions.

It will stop when it detects the final Submit control and write `application-draft.json`.

## Why this replaces Browserbase

The existing `freebrowser-apply.js` depends on a separate local browser API at port 8765. The native agent instead talks directly to Termux Browser Pilot, so there is no Browserbase account, remote browser session, or Android Playwright browser download in this path.
