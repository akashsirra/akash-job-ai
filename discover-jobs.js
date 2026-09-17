require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function looksLikeTargetTitle(title) {
  const value = normalize(title);
  return (rules.target_roles || []).some(role => value.includes(normalize(role)));
}

function looksLikeSearchPage(title, url) {
  return /search results|jobs? in |job search|careers? home|find jobs/i.test(`${title} ${url}`);
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (/google\./i.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  }

  const queries = [
    `"Software Engineer" fresher Hyderabad jobs`,
    `"Software Engineer" fresher Bangalore jobs`,
    `"Software Engineer" "Remote India" fresher jobs`
  ];

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID
  });
  console.log("☁️ Browserbase session created");

  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  const page = await browser.newPage();
  const discovered = [];

  try {
    for (const query of queries) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 1200));

      const results = await page.evaluate(() =>
        [...document.querySelectorAll("a")]
          .map(a => ({
            text: (a.innerText || "").trim().replace(/\s+/g, " "),
            href: a.href
          }))
          .filter(x => x.text && x.href)
      );

      for (const result of results) {
        const href = canonicalUrl(result.href);
        if (!href || looksLikeSearchPage(result.text, href)) continue;
        if (!looksLikeTargetTitle(result.text)) continue;

        const existing = discovered.find(x => x.posting_url === href);
        if (existing) continue;

        discovered.push({
          title: result.text.slice(0, 180),
          company: "Unknown",
          location: query.includes("Bangalore")
            ? "Bangalore, India"
            : query.includes("Hyderabad")
              ? "Hyderabad, India"
              : "Remote India",
          posting_url: href,
          source_context: [query, result.text],
          status: "needs_verification",
          browserbase_required: true
        });
      }
    }
  } finally {
    await browser.close();
  }

  const queue = fs.existsSync("./job-queue.json")
    ? JSON.parse(fs.readFileSync("./job-queue.json", "utf8"))
    : [];

  const merged = [...queue];
  for (const job of discovered) {
    const duplicate = merged.some(existing =>
      normalize(existing.posting_url) === normalize(job.posting_url) ||
      (normalize(existing.title) === normalize(job.title) &&
        normalize(existing.company) === normalize(job.company) &&
        normalize(existing.location) === normalize(job.location))
    );
    if (!duplicate) merged.push(job);
  }

  fs.writeFileSync("./job-queue.json", JSON.stringify(merged, null, 2));

  console.log(`\n🔎 Discovered ${discovered.length} candidate links`);
  console.log(`📋 Queue size: ${merged.length}`);
  console.log("Browserbase sessions used: 1");
  console.log(`Profile: ${profile.name}`);
}

main().catch(error => {
  console.error("\n❌ DISCOVERY ERROR:", error.message);
  process.exit(1);
});
