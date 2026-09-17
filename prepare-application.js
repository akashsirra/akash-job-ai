require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");
const { matchJob } = require("./matcher");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

const STOP_BEFORE_SUBMIT = rules.application_policy?.stop_before_final_submission !== false;

// ---------- field → value mapping ----------
// Extend this as your profile.json grows. Anything not mapped here is left
// for you to fill by hand (better a blank field than an invented answer).
function fieldKey(field) {
  return `${field.label || ""} ${field.name || ""} ${field.id || ""} ${field.placeholder || ""} ${field.autocomplete || ""}`.toLowerCase();
}

function valueForField(field) {
  const key = fieldKey(field);
  const parts = String(profile.name || "").trim().split(/\s+/);

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
  if (/graduation year|passing year/.test(key)) return profile.graduation_year || null;
  if (/university|college|institution/.test(key)) return profile.university || null;

  return null;
}

// Fields we will never auto-fill, even if we could pattern-match a guess.
const NEVER_FILL = /password|otp|verification code|captcha|resume|cv upload|cover letter|signature/i;

// ---------- page inspection ----------
async function inspectFields(page) {
  const inspect = frame => frame.evaluate(() => [...document.querySelectorAll("input, textarea, select")]
    .map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      label: el.labels?.[0]?.innerText?.trim()
        || document.querySelector(`label[for="${CSS.escape(el.id || "")}"]`)?.innerText?.trim()
        || "",
      placeholder: el.placeholder || "",
      autocomplete: el.autocomplete || "",
      required: Boolean(el.required),
      options: el.tagName.toLowerCase() === "select"
        ? [...el.options].map(o => o.textContent.trim())
        : undefined
    })));

  for (const frame of page.frames()) {
    try {
      const fields = await inspect(frame);
      if (fields.length) return { frame, fields };
    } catch {}
  }
  return { frame: null, fields: [] };
}

async function findApplyInFrame(frame) {
  return frame.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit],div,span")].find(x => {
      const t = text(x);
      return visible(x) && (/^apply( now)?$/i.test(t) || /apply now|apply for this job/i.test(t)) && !/add to cart|save/i.test(t);
    });
    if (!el) return null;
    return { text: text(el), href: el.closest("a")?.href || el.href || "", tag: el.tagName.toLowerCase() };
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
        const visible = el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit],div,span")].find(x => {
          const t = text(x);
          return visible(x) && (/^apply( now)?$/i.test(t) || /apply now|apply for this job/i.test(t)) && !/add to cart|save/i.test(t);
        });
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

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText?.slice(0, 16000) || "").catch(() => "");
}

// ---------- live field filling ----------
// Actually types/selects values into the page. Never touches NEVER_FILL
// fields and never writes a value we didn't already map with confidence.
async function fillFields(frame, fields) {
  const filled = [];
  const skipped = [];

  for (const field of fields) {
    const key = fieldKey(field);

    if (NEVER_FILL.test(key)) {
      skipped.push({ ...field, reason: "sensitive_or_file_upload" });
      continue;
    }

    const value = valueForField(field);
    if (!value) {
      if (field.required) skipped.push({ ...field, reason: "no_mapped_value" });
      continue;
    }

    try {
      const selector = field.id ? `#${CSS.escape(field.id)}`
        : field.name ? `[name="${CSS.escape(field.name)}"]`
        : null;
      if (!selector) { skipped.push({ ...field, reason: "no_selector" }); continue; }

      const handle = await frame.$(selector);
      if (!handle) { skipped.push({ ...field, reason: "selector_not_found" }); continue; }

      if (field.tag === "select") {
        const optionMatch = (field.options || []).find(
          o => o.toLowerCase().includes(String(value).toLowerCase())
        );
        if (optionMatch) {
          await handle.select(optionMatch).catch(() => {});
          filled.push({ ...field, value: optionMatch });
        } else {
          skipped.push({ ...field, reason: "no_matching_option" });
        }
      } else {
        await handle.click({ clickCount: 3 }).catch(() => {});
        await handle.type(String(value), { delay: 15 }).catch(() => {});
        filled.push({ ...field, value });
      }
    } catch (err) {
      skipped.push({ ...field, reason: `fill_error: ${err.message}` });
    }
  }

  return { filled, skipped };
}

// ---------- main ----------
async function main() {
  const candidate = queue.find(job => job.official_url && job.status === "verified" && matchJob(job).eligible);
  if (!candidate) {
    console.log("No verified eligible job is ready for application preparation.");
    return;
  }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  }

  console.log("\n📝 PREPARING APPLICATION\n");
  console.log("Company:", candidate.company);
  console.log("Role:", candidate.title);
  console.log("URL:", candidate.official_url);

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  let page = await browser.newPage();

  // Live-view link so you can watch, and take over for the final click.
  const debug = await bb.sessions.debug(session.id).catch(() => null);
  const liveViewUrl = debug?.debuggerFullscreenUrl || debug?.debuggerUrl || null;

  try {
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 8000));

    let applicationUrl = page.url();
    let { frame, fields } = await inspectFields(page);
    let body = await pageText(page);

    console.log("🌐 Loaded:", applicationUrl);

    const applyTarget = await clickApply(page);
    if (applyTarget) {
      if (typeof applyTarget === "string") {
        console.log("🔗 Application portal:", applyTarget);
        const next = await browser.newPage();
        await next.goto(applyTarget, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));
        page = next;
      } else {
        page = applyTarget;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      applicationUrl = page.url();
      ({ frame, fields } = await inspectFields(page));
      body = await pageText(page);
    }

    let filled = [], skipped = [];
    if (frame && fields.length) {
      ({ filled, skipped } = await fillFields(frame, fields));
    }

    const unknownRequired = skipped.filter(f => f.required);

    const result = {
      prepared_at: new Date().toISOString(),
      company: candidate.company,
      title: candidate.title,
      official_url: candidate.official_url,
      application_url: applicationUrl,
      live_view_url: liveViewUrl,
      fields_filled: filled,
      fields_skipped: skipped,
      unknown_required_fields: unknownRequired,
      final_submission: "NOT PERFORMED"
    };
    fs.writeFileSync("./application-draft.json", JSON.stringify(result, null, 2));

    console.log(`\n📋 Application URL: ${applicationUrl}`);
    console.log(`✅ Fields filled live: ${filled.length}`);
    console.log(`⚠️  Fields skipped: ${skipped.length} (of which required: ${unknownRequired.length})`);
    if (unknownRequired.length) {
      console.log("   Needs your input:");
      unknownRequired.forEach(f => console.log(`   - ${f.label || f.name || f.id} (${f.reason})`));
    }
    console.log("💾 Saved application-draft.json");

    if (STOP_BEFORE_SUBMIT) {
      console.log("\n🛑 stop_before_final_submission is ON (job-rules.json).");
      console.log("   The form is filled and the session is staying open.");
      if (liveViewUrl) console.log(`   Review & submit yourself here: ${liveViewUrl}`);
      console.log("   Press Ctrl+C once you're done to close the session.");
      await new Promise(() => {}); // hold the process open; user reviews & submits manually
    } else {
      console.log("\n⚠️  stop_before_final_submission is OFF — closing session without submitting.");
      console.log("   (This script still never clicks Submit itself.)");
    }
  } finally {
    if (STOP_BEFORE_SUBMIT) {
      // session stays open deliberately — closed manually or via Browserbase dashboard/timeout
    } else {
      await browser.close();
    }
  }
}

main().catch(error => {
  console.error("\n❌ APPLICATION PREPARATION ERROR:", error.message);
  process.exit(1);
});
