require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

function isLikelyOfficial(url, company) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const compact = String(company || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const firstToken = String(company || "")
      .toLowerCase()
      .split(/\s+/)[0]
      .replace(/[^a-z0-9]/g, "");

    if (compact && host.includes(compact)) return true;
    if (firstToken && firstToken.length >= 2 && host.includes(firstToken)) return true;

    return /(^|\.)((myworkdayjobs|greenhouse|lever|ashbyhq)\.com)$/i.test(host) ||
      /(^|\.)(workday|icims|smartrecruiters)\./i.test(host) ||
      /careers?|jobs?/i.test(host);
  } catch {
    return false;
  }
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function relevantSearchResult(result, job) {
  const text = normalize(`${result.text} ${result.href}`);
  const title = normalize(job.title);
  const company = normalize(job.company);
  const titleWords = title
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4 && !["software", "engineer", "apprentice"].includes(word));

  return (
    text.includes(company) ||
    text.includes("f5.com") ||
    titleWords.some(word => text.includes(word))
  );
}

async function discoverPostingUrl(page, job) {
  const query = `"${job.title}" "${job.company}" ${job.location || ""}`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  console.log("🔎 No posting URL stored; searching for the posting...");
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const results = await page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .map(a => ({
        text: (a.innerText || "").trim().replace(/\s+/g, " "),
        href: a.href
      }))
      .filter(x => x.text && x.href && !/google\.com\/search/i.test(x.href))
  );

  const match = results.find(result => relevantSearchResult(result, job));
  if (!match) return null;

  console.log("🔗 Discovered posting:", match.href);
  return match.href;
}

async function findOfficialApplication(page, job, data) {
  const candidates = data.links
    .map(link => ({ ...link, href: String(link.href || "").trim() }))
    .filter(link => /^https?:\/\//i.test(link.href))
    .filter(link => !/google\.com|unstop\.com/i.test(new URL(link.href).hostname));

  const direct = candidates.find(link =>
    /apply|application|submit|careers|job details|view job/i.test(link.text) &&
    isLikelyOfficial(link.href, job.company)
  );
  if (direct) return direct.href;

  const official = candidates.find(link => isLikelyOfficial(link.href, job.company));
  if (official) return official.href;

  const searchQuery = `"${job.title}" "${job.company}" official careers`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
  console.log("🔎 No official application link exposed; searching for the official/ATS posting in the same session...");

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const results = await page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .map(a => ({
        text: (a.innerText || "").trim().replace(/\s+/g, " "),
        href: a.href
      }))
      .filter(x => x.text && x.href && !/google\.com\/search/i.test(x.href))
  );

  const match = results.find(result =>
    isLikelyOfficial(result.href, job.company) &&
    /apply|application|careers|job|engineer|apprentice/i.test(`${result.text} ${result.href}`)
  ) || results.find(result => isLikelyOfficial(result.href, job.company));

  return match ? match.href : null;
}

async function main() {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
  const index = queue.findIndex(job => job.status !== "verified" && job.application_status !== "applied");

  if (index === -1) {
    console.log("No unverified job is waiting.");
    return;
  }

  const job = queue[index];
  console.log("\n🤖 VERIFYING ONE JOB\n");
  console.log("Title:", job.title);
  console.log("Company:", job.company);
  console.log("Posting URL:", job.posting_url || "not stored — discovery will run inside this verification session");

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
    const postingUrl = job.posting_url || await discoverPostingUrl(page, job);

    if (!postingUrl) {
      queue[index] = {
        ...job,
        status: "needs_review",
        verification_error: "Could not discover a posting URL"
      };
      fs.writeFileSync("./job-queue.json", JSON.stringify(queue, null, 2));
      console.log("⚠️ Could not discover a posting URL; saved needs_review.");
      return;
    }

    await page.goto(postingUrl, {
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

    const officialUrl = await findOfficialApplication(page, job, data);

    queue[index] = {
      ...job,
      posting_url: postingUrl,
      source_url: postingUrl,
      resolved_url: data.url,
      page_title: data.title,
      description: data.text,
      official_url: officialUrl || job.official_url || null,
      status: officialUrl || job.official_url ? "verified" : "needs_review",
      verified_at: new Date().toISOString(),
      verification_error: officialUrl || job.official_url ? undefined : "Official application URL not identified"
    };

    if (!queue[index].verification_error) delete queue[index].verification_error;
    fs.writeFileSync("./job-queue.json", JSON.stringify(queue, null, 2));

    console.log("\n🌐 FINAL URL:\n" + data.url);
    console.log("\n📄 PAGE TITLE:\n" + data.title);
    console.log("\n🔗 OFFICIAL APPLICATION:\n" + (officialUrl || job.official_url || "Not identified"));
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
