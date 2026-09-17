require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

function isLikelyOfficial(url, company) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const companyToken = String(company || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    if (!companyToken) return false;
    if (host.includes(companyToken)) return true;

    return /(^|\.)((myworkdayjobs|greenhouse|lever|ashbyhq)\.com)$/i.test(host) ||
      /(^|\.)(workday|icims|smartrecruiters)\./i.test(host) ||
      /careers?|jobs?/i.test(host);
  } catch {
    return false;
  }
}

async function main() {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
  const index = queue.findIndex(job =>
    job.status !== "verified" && job.posting_url
  );

  if (index === -1) {
    console.log("No unverified job with a posting_url is waiting.");
    console.log("Run discovery first to add posting URLs.");
    return;
  }

  const job = queue[index];
  console.log("\n🤖 VERIFYING ONE JOB\n");
  console.log("Title:", job.title);
  console.log("Company:", job.company);
  console.log("Posting URL:", job.posting_url);

  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  }

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID
  });
  console.log("☁️ Browserbase session created");

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl
  });
  const page = await browser.newPage();

  try {
    await page.goto(job.posting_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const data = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 20000),
      links: [...document.querySelectorAll("a")]
        .map(a => ({ text: (a.innerText || "").trim(), href: a.href }))
        .filter(x => x.text && x.href)
    }));

    const official = data.links.find(link =>
      /apply|official|careers|job details|view job/i.test(link.text) &&
      isLikelyOfficial(link.href, job.company)
    ) || data.links.find(link => isLikelyOfficial(link.href, job.company));

    queue[index] = {
      ...job,
      resolved_url: data.url,
      page_title: data.title,
      description: data.text,
      official_url: official ? official.href : job.official_url,
      status: official || isLikelyOfficial(data.url, job.company) ? "verified" : "needs_review",
      verified_at: new Date().toISOString()
    };

    fs.writeFileSync("./job-queue.json", JSON.stringify(queue, null, 2));

    console.log("\n🌐 FINAL URL:\n" + data.url);
    console.log("\n📄 PAGE TITLE:\n" + data.title);
    console.log("\n🔗 OFFICIAL APPLICATION:\n" + (queue[index].official_url || "Not identified"));
    console.log("\n💾 Saved verification to job-queue.json");
  } finally {
    await browser.close();
  }

  console.log("\n✅ Posting inspection complete.");
  console.log("Browserbase sessions used: 1");
}

main().catch(error => {
  console.error("\n❌ ERROR:", error.message);
  process.exit(1);
});
