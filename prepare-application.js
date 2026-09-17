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
  return page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")].map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      label: el.labels?.[0]?.innerText?.trim() || "",
      placeholder: el.placeholder || "",
      autocomplete: el.autocomplete || "",
      required: Boolean(el.required)
    }))
  );
}

async function findApplyTarget(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("a,button,[role='button']")];
    return candidates.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " "),
      href: el.href || ""
    })).filter(x => /^(apply|apply now|application|start application)$/i.test(x.text) || /\bapply now\b/i.test(x.text));
  });
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
  const page = await browser.newPage();

  try {
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    let applicationUrl = page.url();
    let fields = await inspectFields(page);

    if (!fields.length) {
      const targets = await findApplyTarget(page);
      const target = targets.find(x => x.href && !/^javascript:/i.test(x.href));

      if (target) {
        console.log("🔗 Application portal found:", target.href);
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60000 });
        await new Promise(r => setTimeout(r, 2500));
        applicationUrl = page.url();
        fields = await inspectFields(page);
      } else {
        const clickable = targets.find(x => !x.href);
        if (clickable) {
          console.log("🖱️ Clicking application control:", clickable.text);
          const controls = await page.$$("a,button,[role='button']");
          if (controls[clickable.index]) {
            await controls[clickable.index].click();
            await new Promise(r => setTimeout(r, 3000));
            applicationUrl = page.url();
            fields = await inspectFields(page);
          }
        }
      }
    }

    const draft = [];
    const unknownRequired = [];
    for (const field of fields) {
      const value = valueForField(field);
      const blocked = /password|otp|verification|captcha|resume|cover letter/i.test(fieldKey(field));
      if (value && !blocked && field.tag !== "select") {
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
