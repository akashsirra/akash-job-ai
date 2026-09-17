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
const FINAL_CONTROL = /^(submit|submit application|send application|finish application|complete application|apply now|send my application)$/i;
const NEXT_CONTROL = /^(next|continue|continue application|save and continue|next step|review application|review and submit|proceed|go to next|save & continue)$/i;
const APPLY_CONTROL = /^(apply|apply now|apply for this job|start application|easy apply)$/i;

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

async function inspectFrame(frame) {
  return frame.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const labelFor = el => {
      const direct = el.labels?.[0]?.innerText?.trim();
      if (direct) return direct;
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.innerText?.trim()) return label.innerText.trim();
      }
      const parent = el.closest("label");
      if (parent?.innerText?.trim()) return parent.innerText.trim();
      return el.getAttribute("aria-label") || el.getAttribute("data-label") || "";
    };
    const roots = [document];
    const walk = root => {
      root.querySelectorAll?.("*").forEach(el => {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
      });
    };
    walk(document);
    const output = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll?.("input, textarea, select") || []) {
        if (!visible(el) || el.disabled) continue;
        output.push({
          tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "",
          label: labelFor(el), placeholder: el.placeholder || "", autocomplete: el.autocomplete || "",
          required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
          readOnly: Boolean(el.readOnly),
          options: el.tagName.toLowerCase() === "select" ? [...el.options].map(o => ({ text: o.textContent.trim(), value: o.value })) : undefined
        });
      }
    }
    return output;
  });
}

async function inspectFields(page) {
  for (const frame of page.frames()) {
    try {
      const fields = await inspectFrame(frame);
      if (fields.length) return { frame, fields };
    } catch {}
  }
  return { frame: null, fields: [] };
}

async function findControls(frame, mode) {
  return frame.evaluate((mode, APPLY, NEXT, FINAL) => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")]
      .filter(visible).map(el => ({ text: text(el), href: el.closest("a")?.href || el.href || "", tag: el.tagName.toLowerCase() }))
      .filter(x => x.text && !/save job|bookmark|filters?|search/i.test(x.text));
    const regex = mode === "apply" ? new RegExp(APPLY, "i") : mode === "next" ? new RegExp(NEXT, "i") : new RegExp(FINAL, "i");
    return candidates.filter(x => regex.test(x.text));
  }, mode, APPLY_CONTROL.source, NEXT_CONTROL.source, FINAL_CONTROL.source);
}

async function clickApply(page) {
  for (const frame of page.frames()) {
    try {
      const controls = await findControls(frame, "apply");
      if (!controls.length) continue;
      const target = controls.sort((a, b) => (a.text.length - b.text.length))[0];
      console.log("🔘 Apply control:", target.text, target.href || "(button)");
      if (target.href && !/^javascript:/i.test(target.href)) return target.href;
      const before = page.url();
      const pagesBefore = await page.browser().pages();
      await frame.evaluate((wanted) => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x => visible(x) && text(x) === wanted);
        if (el) el.click();
      }, target.text);
      await new Promise(resolve => setTimeout(resolve, 4000));
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
      } else if (/^(checkbox|radio)$/i.test(field.type)) {
        skipped.push({ ...field, reason: "choice_requires_explicit_profile_value" });
      } else {
        await handle.click({ clickCount: 3 }).catch(() => {}); await handle.press("Backspace").catch(() => {}); await handle.type(String(value), { delay: 10 });
        const actual = await handle.evaluate(el => el.value || "");
        if (actual === String(value)) filled.push({ ...field, value }); else skipped.push({ ...field, reason: "input_verification_failed" });
      }
      await handle.dispose();
    } catch (err) { skipped.push({ ...field, reason: `fill_error: ${err.message}` }); }
  }
  return { filled, skipped };
}

async function clickNext(page) {
  for (const frame of page.frames()) {
    try {
      const finals = await findControls(frame, "final");
      if (finals.length) return { type: "final", text: finals[0].text };
      const nexts = await findControls(frame, "next");
      if (!nexts.length) continue;
      const target = nexts.sort((a, b) => a.text.length - b.text.length)[0];
      console.log("➡️ Navigation control:", target.text);
      const before = page.url();
      await frame.evaluate((wanted) => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x => visible(x) && text(x) === wanted);
        if (el) el.click();
      }, target.text);
      await new Promise(resolve => setTimeout(resolve, 3500));
      return { type: page.url() !== before ? "navigated" : "advanced", text: target.text };
    } catch {}
  }
  return null;
}

async function main() {
  const candidate = queue.find(job => job.official_url && job.status === "verified" && job.application_status !== "applied" && matchJob(job).eligible);
  if (!candidate) { console.log("No verified eligible job is ready for application preparation."); return; }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");

  console.log("\n📝 PREPARING APPLICATION\n");
  console.log("Company:", candidate.company); console.log("Role:", candidate.title); console.log("URL:", candidate.official_url);
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  let page = await browser.newPage();
  const debug = await bb.sessions.debug(session.id).catch(() => null);
  const liveViewUrl = debug?.debuggerFullscreenUrl || debug?.debuggerUrl || null;
  const allFilled = [], allSkipped = [];
  let applicationUrl = candidate.official_url;

  try {
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 6000));
    console.log("🌐 Loaded:", page.url());

    const directApplicationUrl = eightfoldApplicationUrl(candidate.official_url);
    let applyTarget = directApplicationUrl;
    if (applyTarget) console.log("🧭 Eightfold application portal detected:", applyTarget);
    if (!applyTarget) applyTarget = await clickApply(page);

    if (applyTarget) {
      if (typeof applyTarget === "string" && applyTarget !== page.url()) {
        console.log("🔗 Application portal:", applyTarget);
        const next = await browser.newPage();
        await next.goto(applyTarget, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 6000));
        page = next;
      }
      applicationUrl = page.url();
    }

    let lastSignature = "";
    for (let step = 1; step <= 8; step++) {
      const { frame, fields } = await inspectFields(page);
      console.log(`🔎 Application step ${step}: ${fields.length} form fields`);
      const signature = `${page.url()}|${fields.map(f => `${f.id}:${f.name}:${f.label}`).join("|")}`;
      if (signature === lastSignature && !fields.length) break;
      lastSignature = signature;

      if (frame && fields.length) {
        const result = await fillFields(frame, fields);
        allFilled.push(...result.filled); allSkipped.push(...result.skipped);
      }

      const finalControls = frame ? await findControls(frame, "final").catch(() => []) : [];
      if (finalControls.length) {
        console.log("🛑 Final submission control detected:", finalControls[0].text);
        break;
      }

      const moved = await clickNext(page);
      if (!moved || moved.type === "final") break;
      if (moved.type === "navigated") applicationUrl = page.url();
    }

    const unknownRequired = allSkipped.filter(f => f.required);
    const result = {
      prepared_at: new Date().toISOString(), company: candidate.company, title: candidate.title,
      official_url: candidate.official_url, application_url: applicationUrl, live_view_url: liveViewUrl,
      fields_filled: allFilled, fields_skipped: allSkipped, unknown_required_fields: unknownRequired,
      final_submission: "NOT PERFORMED"
    };
    fs.writeFileSync("./application-draft.json", JSON.stringify(result, null, 2));
    console.log(`\n📋 Application URL: ${applicationUrl}`);
    console.log(`✅ Fields filled live: ${allFilled.length}`);
    console.log(`⚠️ Fields skipped: ${allSkipped.length} (of which required: ${unknownRequired.length})`);
    if (unknownRequired.length) { console.log("   Needs your input:"); unknownRequired.forEach(f => console.log(`   - ${f.label || f.name || f.id} (${f.reason})`)); }
    console.log("💾 Saved application-draft.json");
    console.log("\n🛑 FINAL SUBMISSION WAS NOT PERFORMED.");
    if (liveViewUrl) console.log("   Review in Live View:", liveViewUrl);
    console.log("   After you submit manually: npm run mark-applied -- --confirm");
    if (STOP_BEFORE_SUBMIT) await new Promise(() => {});
  } finally {
    if (!STOP_BEFORE_SUBMIT) await browser.close();
  }
}

main().catch(error => { console.error("\n❌ APPLICATION PREPARATION ERROR:", error.message); process.exit(1); });