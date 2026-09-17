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
  const inspect = async frame => frame.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
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

  for (const frame of page.frames()) {
    try {
      const fields = await inspect(frame);
      if (fields.length) return fields;
    } catch {}
  }
  return [];
}

async function findApplyInFrame(frame) {
  return frame.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const nodes = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit],div,span")];
    const el = nodes.find(x => {
      const t = text(x);
      return visible(x) && (/^apply( now)?$/i.test(t) || /apply now|apply for this job/i.test(t)) && !/add to cart|save/i.test(t);
    });
    if (!el) return null;
    return {
      text: text(el),
      href: el.closest("a")?.href || el.href || "",
      tag: el.tagName.toLowerCase()
    };
  });
}

async function clickApply(page) {
  for (const frame of page.frames()) {
    try {
      const apply = await findApplyInFrame(frame);
      if (!apply) continue;

      console.log("🔘 Apply control:", apply.text, apply.href || "(button)");

      if (apply.href && !/^javascript:/i.test(apply.href) && !/app\.eightfold\.ai\/careers\?/i.test(apply.href)) {
        return apply.href;
      }

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

function eightfoldJobUrl(job) {
  try {
    const u = new URL(job.official_url);
    const m = u.pathname.match(/\/job\/(\d+)/i);
    if (!m) return null;
    return `https://qualcomm.eightfold.ai/careers/job/${m[1]}`;
  } catch {
    return null;
  }
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText?.slice(0, 16000) || "").catch(() => "");
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
    const startUrl = eightfoldJobUrl(candidate) || candidate.official_url;
    if (startUrl !== candidate.official_url) console.log("↪️ Qualcomm Eightfold job page:", startUrl);

    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 8000));

    let applicationUrl = page.url();
    let fields = await inspectFields(page);
    let body = await pageText(page);

    console.log("🌐 Loaded:", applicationUrl);
    console.log("📄 Apply Now visible:", /apply now|apply for this job/i.test(body) ? "yes" : "no");

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
      fields = await inspectFields(page);
      body = await pageText(page);
    }

    const genericSearch = /app\.eightfold\.ai\/careers\?/i.test(applicationUrl) && !/apply now|apply for this job/i.test(body);
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
      job_page_detected: /apply now|job id/i.test(body),
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
