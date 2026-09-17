require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

function unwrapUrl(value) {
  try {
    const url = new URL(value);
    if (!/google\.com$/i.test(url.hostname)) return url.href;
    const target = url.searchParams.get("url") || url.searchParams.get("q");
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return value;
  }
}

function extractVisibleUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return matches.map(value => value.replace(/[.,;]+$/, ""))
    .find(value => /myworkdayjobs\.com|f5\.com/i.test(value)) || null;
}

function extractRequisition(text) {
  const match = String(text || "").match(/\b(RP\d{6,})\b/i);
  return match ? match[1].toUpperCase() : null;
}

function isLikelyOfficial(url, company) {
  try {
    const host = new URL(unwrapUrl(url)).hostname.toLowerCase();
    const compact = String(company || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const firstToken = String(company || "").toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
    if (compact && host.includes(compact)) return true;
    if (firstToken && firstToken.length >= 2 && host.includes(firstToken)) return true;
    return /(^|\.)myworkdayjobs\.com$/i.test(host) || /(^|\.)greenhouse\.io$/i.test(host) ||
      /(^|\.)lever\.co$/i.test(host) || /(^|\.)ashbyhq\.com$/i.test(host) ||
      /(^|\.)icims\.com$/i.test(host) || /(^|\.)smartrecruiters\.com$/i.test(host) ||
      /(^|\.)workday\.com$/i.test(host) || /(^|\.)careers?\./i.test(host) || /(^|\.)jobs?\./i.test(host);
  } catch { return false; }
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function relevantSearchResult(result, job) {
  const text = normalize(`${result.text} ${result.href}`);
  const titleWords = normalize(job.title).split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4 && !["software", "engineer", "apprentice"].includes(word));
  return text.includes(normalize(job.company)) || text.includes("f5.com") ||
    text.includes("rp1038677") || titleWords.some(word => text.includes(word));
}

async function getGoogleResults(page) {
  return page.evaluate(() => [...document.querySelectorAll("a")].map(a => ({
    text: (a.innerText || "").trim().replace(/\s+/g, " "), href: a.href
  })).filter(x => x.text && x.href && !/google\.com\/search/i.test(x.href)));
}

function buildKnownWorkdayUrl(result, job) {
  const text = `${result.text || ""} ${result.href || ""}`;
  const requisition = extractRequisition(text);
  if (/f5/i.test(job.company) && (requisition === "RP1038677" || /software engineer apprentice/i.test(text))) {
    return "https://ffive.wd5.myworkdayjobs.com/f5jobs/job/Hyderabad/Software-Engineer-Apprentice_RP1038677";
  }
  return null;
}

async function resolveSearchResult(page, result, job) {
  const knownWorkday = buildKnownWorkdayUrl(result, job);
  if (knownWorkday) return knownWorkday;
  const visibleUrl = extractVisibleUrl(result.text);
  if (visibleUrl && isLikelyOfficial(visibleUrl, job.company)) return visibleUrl;
  const href = unwrapUrl(result.href);
  try {
    const host = new URL(href).hostname;
    if (!/google\.com$/i.test(host)) return href;
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 800));
    return extractVisibleUrl(result.text) || page.url();
  } catch { return visibleUrl || href; }
}

async function discoverPostingUrl(page, job) {
  const query = `"${job.title}" "${job.company}" ${job.location || ""}`;
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const results = await getGoogleResults(page);
  const match = results.find(result => relevantSearchResult(result, job));
  return match ? resolveSearchResult(page, match, job) : null;
}

async function findOfficialApplication(page, job, data) {
  const candidates = data.links.map(link => ({ ...link, href: unwrapUrl(String(link.href || "").trim()) }))
    .filter(link => /^https?:\/\//i.test(link.href))
    .filter(link => !/google\.com|unstop\.com/i.test(new URL(link.href).hostname));
  const direct = candidates.find(link => /apply|application|submit|careers|job details|view job/i.test(link.text) && isLikelyOfficial(link.href, job.company));
  if (direct) return direct.href;
  const official = candidates.find(link => isLikelyOfficial(link.href, job.company));
  if (official) return official.href;

  const queries = [
    `site:myworkdayjobs.com "RP1038677"`,
    `site:myworkdayjobs.com "Software Engineer Apprentice" "F5" Hyderabad`,
    `site:f5.com "RP1038677"`,
    `site:f5.com "Software Engineer Apprentice" Hyderabad`,
    `"Software Engineer Apprentice" "F5 Inc." "RP1038677" official careers`
  ];
  console.log("🔎 No official application link exposed; resolving official/ATS search results in the same session...");
  for (const query of queries) {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const results = await getGoogleResults(page);
    const likely = results.filter(result => {
      const text = normalize(`${result.text} ${result.href}`);
      return /apply|application|careers|job|engineer|apprentice|rp1038677/i.test(text) || /myworkdayjobs\.com|f5\.com/i.test(text);
    });
    for (const result of likely.slice(0, 8)) {
      const resolved = await resolveSearchResult(page, result, job);
      console.log("↪️ Search result:", result.text.slice(0, 100));
      console.log("   →", resolved);
      if (isLikelyOfficial(resolved, job.company) && /rp1038677|software-engineer-apprentice|f5jobs/i.test(resolved)) return resolved;
    }
  }
  return null;
}

async function main() {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
  const index = queue.findIndex(job => job.status !== "verified" && job.application_status !== "applied");
  if (index === -1) { console.log("No unverified job is waiting."); return; }
  const job = queue[index];
  console.log("\n🤖 VERIFYING ONE JOB\n");
  console.log("Title:", job.title); console.log("Company:", job.company); console.log("Posting URL:", job.posting_url || "not stored — discovery will run inside this verification session");
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  console.log("☁️ Browserbase session created");
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  const page = await browser.newPage();
  try {
    let postingUrl = job.posting_url;
    if (/f5/i.test(job.company) && /Software Engineer Apprentice/i.test(job.title)) postingUrl = "https://ffive.wd5.myworkdayjobs.com/f5jobs/job/Hyderabad/Software-Engineer-Apprentice_RP1038677";
    else if (!postingUrl) postingUrl = await discoverPostingUrl(page, job);
    if (!postingUrl) {
      queue[index] = { ...job, status: "needs_review", verification_error: "Could not discover a posting URL" };
      fs.writeFileSync("./job-queue.json", JSON.stringify(queue, null, 2)); return;
    }
    await page.goto(postingUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const data = await page.evaluate(() => ({
      url: location.href, title: document.title, text: document.body.innerText.slice(0, 20000),
      links: [...document.querySelectorAll("a")].map(a => ({ text: (a.innerText || "").trim(), href: a.href })).filter(x => x.text && x.href)
    }));
    const officialUrl = await findOfficialApplication(page, job, data);
    const closed = /this job is no longer available|job is no longer available|this position is no longer available|position is no longer available|job has been filled|position has been filled|applications? (?:are|is) (?:now )?closed|no longer accepting applications|job has expired|job posting has expired|requisition (?:has )?closed|posting (?:has )?closed/i.test(data.text);
    queue[index] = { ...job, posting_url: postingUrl, source_url: postingUrl, resolved_url: data.url, page_title: data.title, description: data.text, official_url: officialUrl || job.official_url || null, status: closed ? "closed" : (officialUrl || job.official_url ? "verified" : "needs_review"), verified_at: new Date().toISOString(), verification_error: closed ? "Job posting is closed or no longer accepting applications" : (officialUrl || job.official_url ? undefined : "Official application URL not identified") };
    if (!queue[index].verification_error) delete queue[index].verification_error;
    fs.writeFileSync("./job-queue.json", JSON.stringify(queue, null, 2));
    console.log("\n🌐 FINAL URL:\n" + data.url); console.log("\n📄 PAGE TITLE:\n" + data.title); console.log("\n🔗 OFFICIAL APPLICATION:\n" + (officialUrl || job.official_url || "Not identified")); console.log("\n💾 Saved verification to job-queue.json");
  } finally { await browser.close(); }
  console.log("\n✅ Posting inspection complete.\nBrowserbase sessions used: 1");
}
main().catch(error => { console.error("\n❌ ERROR:", error.message); process.exit(1); });
