require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");
const { matchJob } = require("./matcher");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

const STOP_BEFORE_SUBMIT = rules.application_policy?.stop_before_final_submission !== false;
const NEVER_FILL = /password|otp|verification code|captcha|resume|cv upload|cover letter|signature/i;

function fieldKey(field) {
  return `${field.label || ""} ${field.name || ""} ${field.id || ""} ${field.placeholder || ""} ${field.autocomplete || ""}`.toLowerCase();
}

function valueForField(field) {
  const key = fieldKey(field);
  const parts = String(profile.name || "").trim().split(/\s+/);
  const education = profile.education || {};
  if (/first.*name|given.*name/.test(key)) return parts[0] || null;
  if (/last.*name|family.*name|surname/.test(key)) return parts.slice(1).join(" ") || null;
  if (/full.*name|your name/.test(key)) return profile.name || null;
  if (/e-?mail/.test(key)) return profile.email || null;
  if (/phone|mobile|contact number/.test(key)) return profile.phone || null;
  if (/linkedin/.test(key)) return profile.linkedin || null;
  if (/github/.test(key)) return profile.github || null;
  if (/portfolio|personal site|website/.test(key)) return profile.portfolio || null;
  if (/\bcity\b/.test(key)) return profile.city || null;
  if (/\bstate\b|province/.test(key)) return profile.state || null;
  if (/postal|zip/.test(key)) return profile.postal_code || null;
  if (/country/.test(key)) return profile.country || null;
  if (/current (ctc|salary)|expected (ctc|salary)/.test(key)) return profile.expected_salary || null;
  if (/notice period/.test(key)) return profile.notice_period || null;
  if (/graduation year|passing year/.test(key)) return profile.graduation_year ?? education.graduation_year ?? null;
  if (/university|college|institution/.test(key)) return profile.university || education.university || null;
  if (/degree|qualification/.test(key)) return profile.degree || education.degree || null;
  return null;
}

function cssAttribute(name, value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ");
  return `[${name}="${escaped}"]`;
}

function selectorForField(field) {
  if (field.id) return cssAttribute("id", field.id);
  if (field.name) return cssAttribute("name", field.name);
  return null;
}

function normalizeOption(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function chooseOption(options, desired) {
  const target = normalizeOption(desired);
  return (options || []).find(option => normalizeOption(option.value) === target || normalizeOption(option.text) === target || normalizeOption(option.text).includes(target) || target.includes(normalizeOption(option.text))) || null;
}

function eightfoldApplicationUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^\/careers\/job\//i.test(parsed.pathname)) return null;
    const pid = parsed.pathname.split("/").filter(Boolean).pop();
    if (!/^\d+$/.test(pid)) return null;
    const domain = parsed.searchParams.get("domain");
    const params = new URLSearchParams({ pid });
    if (domain) params.set("domain", domain);
    return `${parsed.origin}/careers/apply?${params.toString()}`;
  } catch {
    return null;
  }
}

async function inspectFields(page) {
  const inspect = frame => frame.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
    index, tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "",
    label: el.labels?.[0]?.innerText?.trim() || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText?.trim() : "") || el.getAttribute("aria-label") || "",
    placeholder: el.placeholder || "", autocomplete: el.autocomplete || "",
    required: Boolean(el.required || el.getAttribute("aria-required") === "true"), disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly),
    visible: (() => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; })(),
    options: el.tagName.toLowerCase() === "select" ? [...el.options].map(o => ({ text: o.textContent.trim(), value: o.value })) : undefined
  })));
  for (const frame of page.frames()) {
    try { const fields = await inspect(frame); const usable = fields.filter(field => field.visible && !field.disabled); if (usable.length) return { frame, fields: usable }; } catch {}
  }
  return { frame: null, fields: [] };
}

async function findApplyInFrame(frame) {
  return frame.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].filter(visible).map(el => ({ el, text: text(el), href: el.closest("a")?.href || el.href || "" }))
      .filter(x => x.text && /\bapply(?: now| for this job)?\b/i.test(x.text)).filter(x => !/save|add to cart|filters?|search/i.test(x.text));
    if (!candidates.length) return null;
    const best = candidates.sort((a, b) => { const score = value => (/^apply(?: now)?$/i.test(value) ? 3 : /apply for this job/i.test(value) ? 2 : 1); return score(b.text) - score(a.text); })[0];
    return { text: best.text, href: best.href, tag: best.el.tagName.toLowerCase() };
  });
}

async function clickApply(page) {
  for (const frame of page.frames()) {
    try {
      const apply = await findApplyInFrame(frame);
      if (!apply) continue;
      console.log("🔘 Apply control:", apply.text, apply.href || "(button)");
      if (apply.href && !/^javascript:/i.test(apply.href)) return apply.href;
      const before = page.url();
      const pagesBefore = await page.browser().pages();
      await frame.evaluate(() => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x => visible(x) && /\bapply(?: now| for this job)?\b/i.test(text(x)) && !/save|add to cart|filters?|search/i.test(text(x)));
        if (el) el.click();
      });
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (page.url() !== before) return page.url();
      const pagesAfter = await page.browser().pages();
      const popup = pagesAfter.find(p => !pagesBefore.includes(p) && p.url() !== "about:blank");
      if (popup) return popup;
      return null;
    } catch {}
  }
  return null;
}

async function fillFields(frame, fields) {
  const filled = [], skipped = [];
  for (const field of fields) {
    const key = fieldKey(field);
    if (NEVER_FILL.test(key)) { skipped.push({ ...field, reason: "sensitive_or_file_upload" }); continue; }
    if (field.readOnly) { skipped.push({ ...field, reason: "readonly" }); continue; }
    const value = valueForField(field);
    if (value === null || value === undefined || value === "") { if (field.required) skipped.push({ ...field, reason: "no_mapped_value" }); continue; }
    const selector = selectorForField(field);
    if (!selector) { if (field.required) skipped.push({ ...field, reason: "no_selector" }); continue; }
    try {
      const handle = await frame.$(selector);
      if (!handle) { skipped.push({ ...field, reason: "selector_not_found" }); continue; }
      if (field.tag === "select") {
        const option = chooseOption(field.options, value);
        if (!option) { skipped.push({ ...field, reason: "no_matching_option" }); await handle.dispose(); continue; }
        await handle.select(option.value);
        const actual = await handle.evaluate(el => el.options[el.selectedIndex]?.value || "");
        if (actual !== option.value) skipped.push({ ...field, reason: "select_verification_failed" }); else filled.push({ ...field, value: option.text });
      } else if (/^(checkbox|radio)$/i.test(field.type)) skipped.push({ ...field, reason: "choice_requires_explicit_profile_value" });
      else {
        await handle.click({ clickCount: 3 }).catch(() => {}); await handle.press("Backspace").catch(() => {}); await handle.type(String(value), { delay: 15 });
        const actual = await handle.evaluate(el => el.value || "");
        if (actual === String(value)) filled.push({ ...field, value }); else skipped.push({ ...field, reason: "input_verification_failed" });
      }
      await handle.dispose();
    } catch (err) { skipped.push({ ...field, reason: `fill_error: ${err.message}` }); }
  }
  return { filled, skipped };
}

async function pageText(page) { return page.evaluate(() => document.body?.innerText?.slice(0, 16000) || "").catch(() => ""); }

async function main() {
  const candidate = queue.find(job => job.official_url && job.status === "verified" && job.application_status !== "applied" && matchJob(job).eligible);
  if (!candidate) { console.log("No verified eligible job is ready for application preparation."); return; }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");

  console.log("\n📝 PREPARING APPLICATION\n"); console.log("Company:", candidate.company); console.log("Role:", candidate.title); console.log("URL:", candidate.official_url);
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  let page = await browser.newPage();
  const debug = await bb.sessions.debug(session.id).catch(() => null);
  const liveViewUrl = debug?.debuggerFullscreenUrl || debug?.debuggerUrl || null;

  try {
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 8000));
    let applicationUrl = page.url();
    let { frame, fields } = await inspectFields(page);
    console.log("🌐 Loaded:", applicationUrl);
    console.log("🔎 Initial form fields:", fields.length);

    const directApplicationUrl = eightfoldApplicationUrl(candidate.official_url);
    let applyTarget = directApplicationUrl;
    if (applyTarget) console.log("🧭 Eightfold application portal detected:", applyTarget);

    if (!applyTarget) {
      for (let attempt = 1; attempt <= 3 && !applyTarget; attempt++) {
        console.log(`🔎 Looking for Apply control (${attempt}/3)...`);
        applyTarget = await clickApply(page);
        if (!applyTarget) await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    if (applyTarget) {
      if (typeof applyTarget === "string") {
        console.log("🔗 Application portal:", applyTarget);
        const next = await browser.newPage();
        await next.goto(applyTarget, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 7000));
        page = next;
      } else { page = applyTarget; await new Promise(resolve => setTimeout(resolve, 3000)); }
      applicationUrl = page.url();
      ({ frame, fields } = await inspectFields(page));
    }

    let filled = [], skipped = [];
    if (frame && fields.length) ({ filled, skipped } = await fillFields(frame, fields));
    const unknownRequired = skipped.filter(f => f.required);
    const result = { prepared_at: new Date().toISOString(), company: candidate.company, title: candidate.title, official_url: candidate.official_url, application_url: applicationUrl, live_view_url: liveViewUrl, fields_filled: filled, fields_skipped: skipped, unknown_required_fields: unknownRequired, final_submission: "NOT PERFORMED" };
    fs.writeFileSync("./application-draft.json", JSON.stringify(result, null, 2));
    console.log(`\n📋 Application URL: ${applicationUrl}`); console.log(`🔎 Application form fields: ${fields.length}`); console.log(`✅ Fields filled live: ${filled.length}`); console.log(`⚠️ Fields skipped: ${skipped.length} (of which required: ${unknownRequired.length})`); if (unknownRequired.length) { console.log("   Needs your input:"); unknownRequired.forEach(f => console.log(`   - ${f.label || f.name || f.id} (${f.reason})`)); }
    console.log("💾 Saved application-draft.json");
    if (STOP_BEFORE_SUBMIT) { console.log("\n🛑 stop_before_final_submission is ON (job-rules.json)."); console.log("   Review the live form and submit it yourself."); if (liveViewUrl) console.log(`   Live view: ${liveViewUrl}`); console.log("   After you submit manually, run: npm run mark-applied -- --confirm"); await new Promise(() => {}); }
    else { console.log("\n⚠️ stop_before_final_submission is OFF — closing session without submitting."); console.log("   This script never clicks Submit itself."); }
  } finally { if (!STOP_BEFORE_SUBMIT) await browser.close(); }
}

main().catch(error => { console.error("\n❌ APPLICATION PREPARATION ERROR:", error.message); process.exit(1); });