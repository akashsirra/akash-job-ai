require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");
const { matchJob } = require("./matcher");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

function fieldKey(field) {
  return `${field.label || ""} ${field.name || ""} ${field.placeholder || ""} ${field.autocomplete || ""}`.toLowerCase();
}

function valueForField(field) {
  const key = fieldKey(field);
  const nameParts = String(profile.name || "").trim().split(/\s+/);

  if (/first.*name|given.*name/.test(key)) return nameParts[0] || null;
  if (/last.*name|family.*name|surname/.test(key)) return nameParts.slice(1).join(" ") || null;
  if (/full.*name|your name/.test(key)) return profile.name || null;
  if (/e-?mail/.test(key)) return profile.email || null;
  if (/phone|mobile|contact/.test(key)) return profile.phone || null;
  if (/linkedin/.test(key)) return profile.linkedin || null;
  if (/github/.test(key)) return profile.github || null;
  if (/portfolio|personal site|website/.test(key)) return profile.portfolio || null;

  return null;
}

async function main() {
  const candidate = queue.find(job => {
    if (!job.official_url || job.status !== "verified") return false;
    return matchJob(job).eligible;
  });

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
    await page.goto(candidate.official_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const fields = await page.evaluate(() =>
      [...document.querySelectorAll("input, textarea, select")].map((el, index) => {
        const label = el.labels?.[0]?.innerText?.trim() || "";
        return {
          index,
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          label,
          placeholder: el.placeholder || "",
          autocomplete: el.autocomplete || "",
          required: Boolean(el.required)
        };
      })
    );

    const draft = [];
    const unknownRequired = [];

    for (const field of fields) {
      const value = valueForField(field);
      const sensitiveOrUnknown = /password|otp|verification|captcha|resume|cover letter/i.test(fieldKey(field));

      if (value && !sensitiveOrUnknown && field.tag !== "select") {
        await page.evaluate(({ index, value }) => {
          const fields = [...document.querySelectorAll("input, textarea, select")];
          const el = fields[index];
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, { index: field.index, value });
        draft.push({ ...field, action: "filled", value });
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
      fields: draft,
      unknown_required_fields: unknownRequired,
      final_submission: "NOT PERFORMED"
    };

    fs.writeFileSync("./application-draft.json", JSON.stringify(result, null, 2));

    console.log(`\n✅ Known fields prepared: ${draft.filter(x => x.action === "filled").length}`);
    console.log(`⚠️ Unknown required fields: ${unknownRequired.length}`);
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
