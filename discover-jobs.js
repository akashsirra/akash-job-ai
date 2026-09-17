require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function titlePatterns() {
  return [
    /software\s+(?:engineer|developer)/i,
    /software\s+development\s+engineer/i,
    /\b(?:sde|swe)\b/i,
    /backend\s+(?:engineer|developer)/i,
    /full[- ]?stack\s+(?:engineer|developer)/i,
    /graduate\s+engineer\s+trainee/i,
    /software\s+(?:engineer|developer)\s+trainee/i,
    ...(rules.target_roles || []).map(role => new RegExp(
      `\\b${String(role).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i"
    ))
  ];
}

function looksLikeTargetTitle(title) {
  const value = normalize(title);
  return titlePatterns().some(pattern => pattern.test(value));
}

function looksLikeSearchPage(title, url) {
  return /search results|jobs? in |job search|careers? home|find jobs|google\./i.test(`${title} ${url}`);
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (/google\./i.test(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function extractTitle(text) {
  const lines = String(text || "")
    .split(/\n|\r/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const targetLine = lines.find(line => looksLikeTargetTitle(line));
  if (targetLine) return targetLine.slice(0, 180);

  const targetInline = lines.join(" ").match(/[^|•]{0,100}(?:software|backend|full[- ]?stack|sde|swe)[^|•]{0,100}/i);
  return (targetInline ? targetInline[0] : lines[0] || "Unknown role").slice(0, 180).trim();
}

function buildQueries() {
  const locations = rules.locations || ["Hyderabad", "Bangalore", "Remote India"];
  const roleQueries = ["Software Engineer", "SDE", "Software Developer"];
  return locations.flatMap(location =>
    roleQueries.map(role => `"${role}" fresher "${location}" jobs`)
  );
}

async function main() {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  }

  const queries = buildQueries();

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
        const title = extractTitle(result.text);
        if (!href || looksLikeSearchPage(result.text, href)) continue;
        if (!looksLikeTargetTitle(title)) continue;
        if (/^(images|videos|news|maps|shopping|more)$/i.test(title)) continue;

        const existing = discovered.find(x => x.posting_url === href);
        if (existing) {
          existing.source_context.push(query, result.text);
          continue;
        }

        discovered.push({
          title,
          company: "Unknown",
          location: /bangalore/i.test(query)
            ? "Bangalore, India"
            : /hyderabad/i.test(query)
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
