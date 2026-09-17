require("dotenv").config();
const fs = require("fs");

const BASE = process.env.FREEBROWSER_URL || "http://127.0.0.1:8765";
const QUEUE_FILE = "./job-queue.json";
const BLOCKED_HOSTS = /(^|\.)((instagram|facebook|youtube|youtu|tiktok|x|twitter|linkedin|reddit|pinterest|telegram)\.com|lnkd\.in)$/i;
const ATS_HOSTS = /(^|\.)(myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|icims\.com|smartrecruiters\.com|workday\.com)$/i;
const CLOSED_PATTERNS = [
  /this job is no longer available/i, /job is no longer available/i,
  /this position is no longer available/i, /position is no longer available/i,
  /job has been filled/i, /position has been filled/i,
  /applications? (?:are|is) (?:now )?closed/i,
  /applications? (?:are|is) no longer being accepted/i,
  /no longer accepting applications/i, /job has expired/i,
  /job posting has expired/i, /requisition (?:has )?closed/i,
  /posting (?:has )?closed/i
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function unwrapUrl(value) {
  try {
    const u = new URL(String(value));
    if (!/google\.[^/]+$/i.test(u.hostname)) return u.href;
    const target = u.searchParams.get("url") || u.searchParams.get("q");
    return target ? decodeURIComponent(target) : u.href;
  } catch { return String(value || ""); }
}
function hostOf(url) { try { return new URL(unwrapUrl(url)).hostname.toLowerCase(); } catch { return ""; } }
function isBlocked(url) { return BLOCKED_HOSTS.test(hostOf(url)); }
function isLikelyOfficial(url, company) {
  try {
    const host = hostOf(url);
    if (!host || isBlocked(url)) return false;
    const compact = normalize(company).replace(/[^a-z0-9]/g, "");
    const first = normalize(company).split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
    return (compact && host.includes(compact)) || (first.length >= 2 && host.includes(first)) || ATS_HOSTS.test(host) || /(^|\.)careers?\.|(^|\.)jobs?\./i.test(host);
  } catch { return false; }
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
  if (isBlocked(result.href)) return -1000;
  const text = normalize(`${result.text} ${result.href}`);
  let score = 0;
  const company = normalize(job.company);
  if (company && text.includes(company)) score += 20;
  if (isLikelyOfficial(result.href, job.company)) score += 12;
  if (ATS_HOSTS.test(hostOf(result.href))) score += 8;
  for (const word of normalize(job.title).split(/[^a-z0-9]+/).filter(x => x.length >= 4)) if (text.includes(word)) score += 2;
  if (/apply|careers|job|engineer|apprentice|requisition/i.test(text)) score += 1;
  return score;
}
async function discoverPostingUrl(job) {
  const query = `"${job.title}" "${job.company}" ${job.location || ""}`;
  await api("/navigate", "POST", { url:`https://www.google.com/search?q=${encodeURIComponent(query)}` });
  await sleep(1800);
  const data = await pageSnapshot();
  const ranked = data.links.map(link=>({...link,href:unwrapUrl(link.href)})).filter(link=>/^https?:\/\//i.test(link.href)&&!/^google\.[^/]+$/i.test(hostOf(link.href))&&!isBlocked(link.href)).map(r=>({r,score:scoreResult(r,job)})).sort((a,b)=>b.score-a.score);
  const best = ranked.find(x=>x.score>0)?.r;
  return best?.href || null;
}
async function findOfficialApplication(job, data) {
  const candidates = (data.links||[]).map(link=>({...link,href:unwrapUrl(link.href)})).filter(link=>/^https?:\/\//i.test(link.href)&&!isBlocked(link.href)&&!/^google\.[^/]+$|unstop\.com$/i.test(hostOf(link.href)));
  const direct = candidates.find(link=>/apply|application|careers|job details|view job/i.test(link.text)&&isLikelyOfficial(link.href,job.company));
  if (direct) return direct.href;
  const official = candidates.filter(link=>isLikelyOfficial(link.href,job.company)).sort((a,b)=>scoreResult(b,job)-scoreResult(a,job))[0];
  if (official) return official.href;
  const query = `"${job.title}" "${job.company}" ${job.location||""} official careers apply`;
  await api("/navigate","POST",{url:`https://www.google.com/search?q=${encodeURIComponent(query)}`});
  await sleep(1500);
  const search = await pageSnapshot();
  return search.links.map(link=>({...link,href:unwrapUrl(link.href)})).filter(link=>/^https?:\/\//i.test(link.href)&&!isBlocked(link.href)&&!/^google\.[^/]+$/i.test(hostOf(link.href))).sort((a,b)=>scoreResult(b,job)-scoreResult(a,job)).find(link=>isLikelyOfficial(link.href,job.company))?.href||null;
}
async function main() {
  if (!fs.existsSync(QUEUE_FILE)) throw new Error("No job queue found.");
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE,"utf8"));
  const index = queue.findIndex(job=>job.status!=="verified"&&job.status!=="closed"&&job.application_status!=="applied");
  if (index===-1) { console.log("No unverified job is waiting."); return; }
  const job=queue[index];
  console.log("\n🤖 VERIFYING ONE JOB\n\nTitle:",job.title,"\nCompany:",job.company,"\nPosting URL:",job.posting_url||"not stored — discovery will run in FreeBrowser");
  const status=await api("/status");
  console.log(`🌐 FreeBrowser: ${status.browserAttached?"connected":"not attached"}`);
  if(!status.browserAttached) throw new Error("FreeBrowser browser is not attached. Open FreeBrowser first.");
  let postingUrl=job.posting_url||null;
  if(postingUrl&&isBlocked(postingUrl)) { console.log("🧹 Rejected blocked/social-media posting URL:",postingUrl); postingUrl=null; }
  if(!postingUrl) postingUrl=await discoverPostingUrl(job);
  if(!postingUrl) {
    queue[index]={...job,status:"needs_review",verification_error:"Could not discover a valid job posting URL using FreeBrowser"};
    fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue,null,2)); console.log("⚠️ Could not discover a valid posting URL."); return;
  }
  await api("/navigate","POST",{url:postingUrl}); await sleep(2500);
  const data=await pageSnapshot();
  if(isBlocked(data.url)||isBlocked(postingUrl)) {
    queue[index]={...job,status:"needs_review",posting_url:null,resolved_url:data.url,verification_error:"Discovery resolved to a blocked social-media URL; valid job URL not found"};
    fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue,null,2)); console.log("⚠️ Rejected social-media result:",data.url); return;
  }
  const closed=isClosed(data.text); const officialUrl=closed?null:await findOfficialApplication(job,data); const resolvedOfficial=officialUrl||job.official_url||null;
  queue[index]={...job,posting_url:postingUrl,source_url:postingUrl,resolved_url:data.url,page_title:data.title,description:data.text,official_url:resolvedOfficial,status:closed?"closed":(resolvedOfficial?"verified":"needs_review"),verified_at:new Date().toISOString(),...(closed?{verification_error:"Job posting is closed or no longer accepting applications"}:resolvedOfficial?{}:{verification_error:"Official application URL not identified"})};
  fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue,null,2));
  console.log("\n🌐 FINAL URL:\n"+data.url+"\n\n📄 PAGE TITLE:\n"+data.title+"\n\n🔗 OFFICIAL APPLICATION:\n"+(resolvedOfficial||"Not identified")+`\n\n${closed?"🚫 Job is closed.":resolvedOfficial?"✅ Job verified.":"⚠️ Needs review."}\n💾 Saved verification to job-queue.json\n\n✅ Posting inspection complete.\nFreeBrowser sessions used: 0 cloud sessions");
}
main().catch(error=>{console.error("\n❌ ERROR:",error.message);process.exit(1);});
