require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");
const { matchJob } = require("./matcher");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

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
  if (/phone|mobile|contact/.test(key)) return profile.phone || null;
  if (/linkedin/.test(key)) return profile.linkedin || null;
  if (/github/.test(key)) return profile.github || null;
  if (/portfolio|personal site|website/.test(key)) return profile.portfolio || null;
  return null;
}

async function inspectFields(page) {
  const inspect = async p => p.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    type: el.type || "",
    name: el.name || "",
    id: el.id || "",
    label: el.labels?.[0]?.innerText?.trim() || document.querySelector(`label[for="${CSS.escape(el.id || "")}"]`)?.innerText?.trim() || "",
    placeholder: el.placeholder || "",
    autocomplete: el.autocomplete || "",
    required: Boolean(el.required)
  })));

  const top = await inspect(page);
  if (top.length) return top;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const fields = await frame.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        label: el.labels?.[0]?.innerText?.trim() || "",
        placeholder: el.placeholder || "",
        autocomplete: el.autocomplete || "",
        required: Boolean(el.required)
      })));
      if (fields.length) return fields;
    } catch {}
  }
  return [];
}

async function findApply(page) {
  return page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")]
      .filter(visible)
      .map(el => ({
        text: text(el),
        href: el.href || "",
        tag: el.tagName.toLowerCase()
      }))
      .filter(x => /^apply( now)?$/i.test(x.text) || /apply now|apply for this job/i.test(x.text))
      .find(x => !/add to cart|save/i.test(x.text));
  });
}

async function clickApply(page) {
  const apply = await findApply(page);
  if (!apply) return null;

  console.log("🔘 Apply control:", apply.text, apply.href || "(button)");

  if (apply.href && !/^javascript:/i.test(apply.href) && !/app\.eightfold\.ai\/careers\?/i.test(apply.href)) {
    return apply.href;
  }

  const before = page.url();
  const pagesBefore = await page.browser().pages();

  await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const nodes = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")];
    const el = nodes.find(x => {
      const t = (x.innerText || x.textContent || x.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return visible(x) && (/^apply( now)?$/i.test(t) || /apply now|apply for this job/i.test(t));
    });
    if (el) el.click();
  });

  await new Promise(resolve => setTimeout(resolve, 4000));

  if (page.url() !== before) return page.url();

  const pagesAfter = await page.browser().pages();
  const popup = pagesAfter.find(p => !pagesBefore.includes(p) && p.url() !== "about:blank");
  if (popup) return popup;

  return null;
}

function eightfoldJobUrl(officialUrl) {
  try {
    const u = new URL(officialUrl);
    const m = u.pathname.match(/\/job\/(\d+)/i);
    if (!m) return null;
    // Qualcomm's searchable Eightfold route preserves the job id in pid.
    return `https://app.eightfold.ai/careers?pid=${m[1]}&domain=qualcomm.com&sort_by=relevance&triggerGoButton=false`;
  } catch {
    return null;
  }
}

async function pageLooksLikeJob(page) {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 12000)).catch(() => "");
  return /apply now/i.test(text) && /job id/i.test(text);
}

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

  try {
    const eightfoldUrl = eightfoldJobUrl(candidate.official_url);
    const startUrl = eightfoldUrl || candidate.official_url;
    if (eightfoldUrl) console.log("↪️ Qualcomm Eightfold job search route:", eightfoldUrl);

    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));

    let applicationUrl = page.url();
    let fields = await inspectFields(page);

    if (await pageLooksLikeJob(page)) {
      console.log("✅ Qualcomm job listing loaded");
    }

    const applyTarget = await clickApply(page);
    if (applyTarget) {
      if (typeof applyTarget === "string") {
        console.log("🔗 Application portal:", applyTarget);
        const next = await browser.newPage();
        await next.goto(applyTarget, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 4000));
        page = next;
      } else {
        page = applyTarget;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      applicationUrl = page.url();
      fields = await inspectFields(page);
    }

    // Do not mistake Eightfold's search/filter controls for an application form.
    const body = await page.evaluate(() => document.body.innerText.slice(0, 12000)).catch(() => "");
    const genericSearch = /app\.eightfold\.ai\/careers\?/i.test(applicationUrl) &&
      !/apply now/i.test(body);
    if (genericSearch) fields = [];

    const draft = [];
    const unknownRequired = [];
    for (const field of fields) {
      const value = valueForField(field);
      const sensitiveOrUnknown = /password|otp|verification|captcha|resume|cover letter/i.test(fieldKey(field));
      if (value && !sensitiveOrUnknown && field.tag !== "select") {
        draft.push({ ...field, action: "prepared", value });
      } else if (field.required && !value) {
        unknownRequired.push(field);
        draft.push({ ...field, action: "needs_user_input" });
      } else {
        draft.push({ ...field, action: "left_unchanged" });
      }
    }

    const result = {
      prepared_at: new Date().toISOString(),
      company: candidate.company,
      title: candidate.title,
      official_url: candidate.official_url,
      application_url: applicationUrl,
      fields: draft,
      unknown_required_fields: unknownRequired,
      final_submission: "NOT PERFORMED"
    };
    fs.writeFileSync("./application-draft.json", JSON.stringify(result, null, 2));

    console.log(`\n📋 Application URL: ${applicationUrl}`);
    console.log(`✅ Known fields prepared: ${draft.filter(x => x.action === "prepared").length}`);
    console.log(`⚠️ Unknown required fields: ${unknownRequired.length}`);
    console.log(`🔎 Application form fields detected: ${fields.length}`);
    console.log("💾 Saved application-draft.json");
    console.log("🛑 Final submission was NOT performed.");
  } finally {
    await browser.close();
  }

  console.log("Browserbase sessions used: 1");
}

main().catch(error => {
  console.error("\n❌ APPLICATION PREPARATION ERROR:", error.message);
  process.exit(1);
});
