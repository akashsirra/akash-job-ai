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
  return page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
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
}

async function findApplicationControlInContext(context) {
  return context.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const selector = "a,button,[role=button],input[type=button],input[type=submit]";
    const candidates = [...document.querySelectorAll(selector)]
      .filter(visible)
      .map(el => ({
        text: text(el),
        href: el.href || "",
        tag: el.tagName.toLowerCase()
      }))
      .filter(x => /^(apply|apply now|apply for this job|application|submit application)$/i.test(x.text) || /\bapply\b/i.test(x.text));
    return candidates[0] || null;
  });
}

async function findApplicationControl(page) {
  // Qualcomm/Eightfold can render the job UI inside a frame. Search every frame.
  for (const frame of page.frames()) {
    try {
      const found = await findApplicationControlInContext(frame);
      if (found) return { frame, ...found };
    } catch {}
  }
  return null;
}

async function clickApplicationControl(page) {
  const control = await findApplicationControl(page);
  if (!control) return null;

  console.log("🔘 Application control:", control.text, control.href || "(click)");

  if (control.href && !/^javascript:/i.test(control.href)) return control.href;

  const before = page.url();
  const beforePages = new Set(await page.browser().pages());

  try {
    await control.frame.evaluate(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")]
        .find(x => visible(x) && /\bapply\b/i.test(text(x)));
      if (el) el.click();
    });
  } catch {}

  await new Promise(resolve => setTimeout(resolve, 3000));

  if (page.url() !== before) return page.url();

  const pages = await page.browser().pages();
  const popup = pages.find(p => !beforePages.has(p) && p.url() !== "about:blank");
  return popup ? popup.url() : null;
}

function eightfoldFallbackUrl(officialUrl) {
  try {
    const parsed = new URL(officialUrl);
    const match = parsed.pathname.match(/\/job\/(\d+)/i);
    if (!match) return null;
    const parts = parsed.hostname.split(".");
    const domain = parts.length >= 2 ? parts.slice(-2).join(".") : parsed.hostname;
    return `https://app.eightfold.ai/careers?pid=${match[1]}&domain=${encodeURIComponent(domain)}&sort_by=relevance&triggerGoButton=false`;
  } catch {
    return null;
  }
}

async function prepareFromPage(page) {
  let fields = await inspectFields(page);
  if (fields.length) return { page, fields };

  const href = await clickApplicationControl(page);
  if (href && href !== page.url()) {
    console.log("🔗 Application portal:", href);
    const applicationPage = await page.browser().newPage();
    await applicationPage.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    fields = await inspectFields(applicationPage);
    if (fields.length) return { page: applicationPage, fields };
    return { page: applicationPage, fields };
  }

  return { page, fields };
}

async function main() {
  const candidate = queue.find(job => job.official_url && job.status === "verified" && matchJob(job).eligible);
  if (!candidate) {
    console.log("No verified eligible job is ready for application preparation.");
    return;
  }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");

  console.log("\n📝 PREPARING APPLICATION\n");
  console.log("Company:", candidate.company);
  console.log("Role:", candidate.title);
  console.log("URL:", candidate.official_url);

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  let applicationPage = null;

  try {
    const page = await browser.newPage();
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    let result = await prepareFromPage(page);
    applicationPage = result.page;
    let fields = result.fields;

    // Qualcomm's current careers site is powered by Eightfold. If its Apply control
    // is not exposed on the public career page, use the corresponding Eightfold job
    // route in the SAME Browserbase session and inspect it there.
    if (!fields.length) {
      const fallback = eightfoldFallbackUrl(candidate.official_url);
      if (fallback) {
        console.log("↪️ Eightfold job route:", fallback);
        const eightfoldPage = await browser.newPage();
        await eightfoldPage.goto(fallback, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 4000));
        result = await prepareFromPage(eightfoldPage);
        applicationPage = result.page;
        fields = result.fields;
      }
    }

    const applicationUrl = applicationPage.url();
    const draft = [];
    const unknownRequired = [];

    for (const field of fields) {
      const value = valueForField(field);
      const sensitiveOrUnknown = /password|otp|verification|captcha|resume|cover letter/i.test(fieldKey(field));
      if (value && !sensitiveOrUnknown && field.tag !== "select") draft.push({ ...field, action: "prepared", value });
      else if (field.required && !value) {
        unknownRequired.push(field);
        draft.push({ ...field, action: "needs_user_input" });
      } else draft.push({ ...field, action: "left_unchanged" });
    }

    const resultFile = {
      prepared_at: new Date().toISOString(),
      company: candidate.company,
      title: candidate.title,
      official_url: candidate.official_url,
      application_url: applicationUrl,
      fields: draft,
      unknown_required_fields: unknownRequired,
      final_submission: "NOT PERFORMED"
    };
    fs.writeFileSync("./application-draft.json", JSON.stringify(resultFile, null, 2));

    console.log(`\n📋 Application URL: ${applicationUrl}`);
    console.log(`✅ Known fields prepared: ${draft.filter(x => x.action === "prepared").length}`);
    console.log(`⚠️ Unknown required fields: ${unknownRequired.length}`);
    console.log(`🔎 Form fields detected: ${fields.length}`);
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
