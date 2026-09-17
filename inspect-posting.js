require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

function unwrapUrl(value) {
  try {
    const url = new URL(value);
    if (!/google\.[^/]+$/i.test(url.hostname)) return url.href;
    const target = url.searchParams.get("url") || url.searchParams.get("q") || url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return value;
  }
}

function isLikelyOfficial(url, company) {
  try {
    const host = new URL(unwrapUrl(url)).hostname.toLowerCase();
    const compact = String(company || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const firstToken = String(company || "")
      .toLowerCase()
      .split(/\s+/)[0]
      .replace(/[^a-z0-9]/g, "");

    if (compact && host.includes(compact)) return true;
    if (firstToken && firstToken.length >= 2 && host.includes(firstToken)) return true;

    // ATS platforms commonly use company-specific subdomains, e.g. f5.wd5.myworkdayjobs.com.
    if (/(^|\.)myworkdayjobs\.com$/i.test(host)) return true;
    if (/(^|\.)greenhouse\.io$/i.test(host)) return true;
    if (/(^|\.)lever\.co$/i.test(host)) return true;
    if (/(^|\.)ashbyhq\.com$/i.test(host)) return true;
    if (/(^|\.)icims\.com$/i.test(host)) return true;
    if (/(^|\.)smartrecruiters\.com$/i.test(host)) return true;
    if (/(^|\.)workday\.com$/i.test(host)) return true;

    return /(^|\.)((careers?|jobs?)\.[a-z0-9.-]+)$/i.test(host);
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

async function getGoogleResults(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .map(a => ({
        text: (a.innerText || "").trim().replace(/\s+/g, " "),
        href: a.href
      }))
      .filter(x => x.text && x.href && !/google\.com\/search/i.test(x.href))
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

  const results = await getGoogleResults(page);
  const match = results.find(result => relevantSearchResult(result, job));
  if (!match) return null;

  const resolved = unwrapUrl(match.href);
  console.log("🔗 Discovered posting:", resolved);
  return resolved;
}

async function findOfficialApplication(page, job, data) {
  const candidates = data.links
    .map(link => ({ ...link, href: unwrapUrl(String(link.href || "").trim()) }))
    .filter(link => /^https?:\/\//i.test(link.href))
    .filter(link => !/google\.com|unstop\.com/i.test(new URL(link.href).hostname));

  const direct = candidates.find(link =>
    /apply|application|submit|careers|job details|view job/i.test(link.text) &&
    isLikelyOfficial(link.href, job.company)
  );
  if (direct) return direct.href;

  const official = candidates.find(link => isLikelyOfficial(link.href, job.company));
  if (official) return official.href;

  // Search several precise forms. All searches reuse the SAME Browserbase page/session.
  const queries = [
    `site:myworkdayjobs.com "${job.title}" "RP1038677"`,
    `site:myworkdayjobs.com "${job.title}" "${job.company}" Hyderabad`,
    `site:f5.com "${job.title}" "RP1038677"`,
    `site:f5.com "${job.title}" Hyderabad`,
    `"${job.title}" "${job.company}" "RP1038677" official careers`
  ];

  console.log("🔎 No official application link exposed; searching official company/ATS results in the same session...");

  for (const query of queries) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await new Promise(resolve => setTimeout(resolve, 900));

    const results = await getGoogleResults(page);
    const matches = results
      .map(result => ({ ...result, href: unwrapUrl(result.href) }))
      .filter(result => isLikelyOfficial(result.href, job.company))
      .filter(result => /apply|application|careers|job|engineer|apprentice|RP1038677/i.test(`${result.text} ${result.href}`));

    if (matches.length) {
      console.log("🔗 Official/ATS candidate:", matches[0].href);
      return matches[0].href;
    }
  }

  return null;
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
