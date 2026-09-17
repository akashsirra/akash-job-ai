require("dotenv").config();
const fs = require("fs");

const BASE = process.env.FREEBROWSER_URL || "http://127.0.0.1:8765";
const QUEUE_FILE = "./job-queue.json";
const SOCIAL_HOSTS = /(^|\.)((instagram|facebook|youtube|youtu|tiktok|x|twitter|linkedin)\.com)$/i;
const ATS_HOSTS = /(^|\.)(myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|icims\.com|smartrecruiters\.com|workday\.com)$/i;
const CLOSED_PATTERNS = [
  /this job is no longer available/i,
  /job is no longer available/i,
  /this position is no longer available/i,
  /position is no longer available/i,
  /job has been filled/i,
  /position has been filled/i,
  /applications? (?:are|is) (?:now )?closed/i,
  /applications? (?:are|is) no longer being accepted/i,
  /no longer accepting applications/i,
  /job has expired/i,
  /job posting has expired/i,
  /requisition (?:has )?closed/i,
  /posting (?:has )?closed/i
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function unwrapUrl(value) {
  try {
    const u = new URL(String(value));
    if (/google\.[^/]+$/i.test(u.hostname)) {
      const target = u.searchParams.get("url") || u.searchParams.get("q");
      return target ? decodeURIComponent(target) : u.href;
    }
    return u.href;
  } catch { return String(value || ""); }
}
function hostname(url) { try { return new URL(unwrapUrl(url)).hostname.toLowerCase(); } catch { return ""; } }
function isSocial(url) { return SOCIAL_HOSTS.test(hostname(url)); }
function isLikelyOfficial(url, company) {
  const host = hostname(url);
  if (!host || isSocial(url)) return false;
  const compact = normalize(company).replace(/[^a-z0-9]/g, "");
  const first = normalize(company).split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
  return (compact && host.includes(compact)) || (first.length >= 2 && host.includes(first)) || ATS_HOSTS.test(host) || /(^|\.)careers?\.|(^|\.)jobs?\./i.test(host);
}
function isClosed(text) { return CLOSED_PATTERNS.some(pattern => pattern.test(String(text || ""))); }

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`FreeBrowser returned non-JSON from ${path}: ${raw.slice(0, 300)}`); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `FreeBrowser ${response.status} on ${path}`);
  return data;
}
async function evaluate(script) {
  const data = await api("/evaluate", "POST", { script });
  try { return JSON.parse(data.result); } catch { return data.result; }
}
async function pageSnapshot() {
  return evaluate(`(() => ({url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,30000),links:[...document.querySelectorAll("a")].map(a=>({text:(a.innerText||a.textContent||a.getAttribute("aria-label")||"").replace(/\\s+/g," ").trim(),href:a.href||""})).filter(x=>x.text&&x.href)}))()`);
}
function scoreResult(result, job) {
  if (isSocial(result.href)) return -1000;
  const text = normalize(`${result.text} ${result.href}`);
  let score = 0;
  const company = normalize(job.company);
  if (company && text.includes(company)) score += 20;
  if (isLikelyOfficial(result.href, job.company)) score += 15;
  if (ATS_HOSTS.test(hostname(result.href))) score += 10;
  for (const word of normalize(job.title).split(/[^a-z0-9]+/).filter(x => x.length >= 4)) if (text.includes(word)) score += 2;
  if (/apply|careers|job|engineer|apprentice|requisition/i.test(text)) score += 1;
  return score;
}
async function discoverPostingUrl(job) {
  const query = `"${job.title}" "${job.company}" ${job.location || ""}`;
  await api("/navigate", "POST", {url:`https://www.google.com/search?q=${encodeURIComponent(query)}`});
  await sleep(1800);
  const data = await pageSnapshot();
  const ranked = data.links.map(link=>({...link,href:unwrapUrl(link.href)}))
    .filter(link=>/^https?:\/\//i.test(link.href)&&!/^google\./i.test(hostname(link.href))&&!isSocial(link.href))
    .map(r=>({r,score:scoreResult(r,job)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  return ranked[0]?.r.href || null;
}
async function findOfficialApplication(job, data) {
  const candidates = (data.links||[]).map(link=>({...link,href:unwrapUrl(link.href)}))
    .filter(link=>/^https?:\/\//i.test(link.href)&&!isSocial(link.href)&&!/^google\./i.test(hostname(link.href)));
  const direct = candidates.find(link=>/apply|application|careers|job details|view job/i.test(link.text)&&isLikelyOfficial(link.href,job.company));
  if (direct) return direct.href;
  const official = candidates.find(link=>isLikelyOfficial(link.href,job.company));
  if (official) return official.href;
  const query=`"${job.title}" "${job.company}" ${job.location||""} official careers apply`;
  await api("/navigate","POST",{url:`https://www.google.com/search?q=${encodeURIComponent(query)}`});
  await sleep(1500);
  const search=await pageSnapshot();
  return search.links.map(link=>({...link,href:unwrapUrl(link.href)}))
    .filter(link=>/^https?:\/\//i.test(link.href)&&!isSocial(link.href)&&!/^google\./i.test(hostname(link.href)))
    .map(r=>({r,score:scoreResult(r,job)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score)
    .find(x=>isLikelyOfficial(x.r.href,job.company))?.r.href || null;
}
async function main() {
  if (!fs.existsSync(QUEUE_FILE)) throw new Error("No job queue found.");
  const queue=JSON.parse(fs.readFileSync(QUEUE_FILE,"utf8"));
  const index=queue.findIndex(job=>job.status!=="verified"&&job.status!=="closed"&&job.application_status!=="applied");
  if(index===-1){console.log("No unverified job is waiting.");return;}
  const job=queue[index];
  console.log("\n🤖 VERIFYING ONE JOB\n");
  console.log("Title:",job.title); console.log("Company:",job.company);
  console.log("Posting URL:",job.posting_url||"not stored — discovery will run in FreeBrowser");
  const status=await api("/status");
  console.log(`🌐 FreeBrowser: ${status.browserAttached?"connected":"not attached"}`);
  if(!status.browserAttached) throw new Error("FreeBrowser browser is not attached. Open FreeBrowser first.");

  let postingUrl=job.posting_url||null;
  if(isSocial(postingUrl)) postingUrl=null;
  if(!postingUrl) postingUrl=await discoverPostingUrl(job);
  if(!postingUrl||isSocial(postingUrl)) {
    queue[index]={...job,status:"needs_review",verification_error:"No valid employer/ATS posting URL found; social-media URLs are rejected"};
    fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue,null,2));
    console.log("⚠️ No valid employer/ATS posting URL found."); return;
  }
  await api("/navigate","POST",{url:postingUrl}); await sleep(2500);
  const data=await pageSnapshot();
  const closed=isClosed(data.text);
  const officialUrl=closed?null:await findOfficialApplication(job,data);
  const resolvedOfficial=officialUrl||job.official_url||null;
  queue[index]={...job,posting_url:postingUrl,source_url:postingUrl,resolved_url:data.url,page_title:data.title,description:data.text,official_url:resolvedOfficial,status:closed?"closed":(resolvedOfficial?"verified":"needs_review"),verified_at:new Date().toISOString(),...(closed?{verification_error:"Job posting is closed or no longer accepting applications"}:resolvedOfficial?{}:{verification_error:"Official application URL not identified"})};
  fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue,null,2));
  console.log("\n🌐 FINAL URL:\n"+data.url); console.log("\n📄 PAGE TITLE:\n"+data.title); console.log("\n🔗 OFFICIAL APPLICATION:\n"+(resolvedOfficial||"Not identified"));
  console.log(`\n${closed?"🚫 Job is closed.":resolvedOfficial?"✅ Job verified.":"⚠️ Needs review."}`);
  console.log("💾 Saved verification to job-queue.json"); console.log("\n✅ Posting inspection complete.\nFreeBrowser sessions used: 0 cloud sessions");
}
main().catch(error=>{console.error("\n❌ ERROR:",error.message);process.exit(1);});
