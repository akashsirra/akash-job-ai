require("dotenv").config();
const fs = require("fs");

const PROFILE_PATH = "./profile.json";
const RULES_PATH = "./job-rules.json";
const QUEUE_PATH = "./job-queue.json";

function readJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titlePatterns(rules) {
  return [
    /software\s+(?:engineer|developer)/i,
    /software\s+development\s+engineer/i,
    /\b(?:sde|swe)\b/i,
    /backend\s+(?:engineer|developer)/i,
    /full[- ]?stack\s+(?:engineer|developer)/i,
    /graduate\s+engineer\s+trainee/i,
    /software\s+(?:engineer|developer)\s+trainee/i,
    ...(rules.target_roles || []).map(role => new RegExp(`\\b${escapeRegex(role)}\\b`, "i"))
  ];
}

function looksLikeTargetTitle(title, rules) {
  const value = normalize(title);
  return titlePatterns(rules).some(pattern => pattern.test(value));
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (/(^|\.)google\./i.test(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AkashJobAI/1.0",
        Accept: "application/json,text/plain,*/*"
      }
    });
    if (!response.ok) {
      console.warn(`⚠️ ${label}: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(`⚠️ ${label}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchLever(slug, companyName) {
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    `lever:${slug}`
  );
  if (!Array.isArray(data)) return [];

  return data.map(job => ({
    title: job.text || "Unknown role",
    company: companyName || slug,
    location: job.categories?.location || "Unknown",
    description: job.descriptionPlain || job.description || "",
    posting_url: job.hostedUrl || job.applyUrl,
    source_context: [`lever:${slug}`]
  }));
}

async function fetchGreenhouse(slug, companyName) {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    `greenhouse:${slug}`
  );
  if (!data || !Array.isArray(data.jobs)) return [];

  return data.jobs.map(job => ({
    title: job.title || "Unknown role",
    company: companyName || slug,
    location: job.location?.name || "Unknown",
    description: job.content || "",
    posting_url: job.absolute_url,
    source_context: [`greenhouse:${slug}`]
  }));
}

async function fetchRemotive(query) {
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`,
    `remotive:${query}`
  );
  if (!data || !Array.isArray(data.jobs)) return [];

  return data.jobs.map(job => ({
    title: job.title || "Unknown role",
    company: job.company_name || "Unknown",
    location: job.candidate_required_location || "Remote",
    description: job.description || "",
    posting_url: job.url,
    source_context: [`remotive:${query}`]
  }));
}

function isUsefulLocation(location, rules) {
  const value = normalize(location);
  if (!value || value === "unknown") return true;
  if (/remote|worldwide|anywhere/i.test(value)) return true;

  const wanted = (rules.locations || []).map(normalize);
  return wanted.some(target => {
    if (target.includes("hyderabad")) return /hyderabad/i.test(value);
    if (target.includes("bangalore")) return /bangalore|bengaluru/i.test(value);
    if (target.includes("remote india")) return /india/i.test(value) && /remote|anywhere/i.test(value);
    return value.includes(target);
  });
}

function isObviouslySenior(candidate) {
  const text = normalize(`${candidate.title} ${candidate.description}`);
  return /\b(?:senior|sr\.?|staff|principal|lead|director|manager|head|vp|vice president)\b/i.test(text) &&
    !/associate|junior|graduate|trainee|entry.?level/i.test(text);
}

function toQueueEntry(candidate, rules) {
  const href = canonicalUrl(candidate.posting_url);
  if (!href) return null;
  if (!looksLikeTargetTitle(candidate.title, rules)) return null;
  if (!isUsefulLocation(candidate.location, rules)) return null;
  if (isObviouslySenior(candidate)) return null;

  return {
    title: String(candidate.title).slice(0, 180),
    company: candidate.company || "Unknown",
    location: candidate.location || "Unknown",
    posting_url: href,
    source_context: candidate.source_context || [],
    status: "needs_verification",
    browserbase_required: true
  };
}

function dedupeAndMerge(existingQueue, newEntries) {
  const merged = [...existingQueue];
  let added = 0;

  for (const job of newEntries) {
    const duplicate = merged.some(existing =>
      normalize(existing.posting_url) === normalize(job.posting_url) ||
      (normalize(existing.title) === normalize(job.title) &&
        normalize(existing.company) === normalize(job.company) &&
        normalize(existing.location) === normalize(job.location))
    );

    if (!duplicate) {
      merged.push(job);
      added += 1;
    }
  }

  return { merged, added };
}

async function collectCandidates(rules) {
  const candidates = [];
  const companies = rules.target_companies || [];

  console.log(`📡 ATS companies: ${companies.length}`);

  for (const target of companies) {
    if (!target?.slug || !target?.ats) continue;

    let jobs = [];
    if (target.ats === "lever") {
      jobs = await fetchLever(target.slug, target.name);
    } else if (target.ats === "greenhouse") {
      jobs = await fetchGreenhouse(target.slug, target.name);
    } else {
      console.warn(`⚠️ Unknown ATS: ${target.ats} (${target.name || target.slug})`);
      continue;
    }

    console.log(`  ${target.name || target.slug}: ${jobs.length} postings`);
    candidates.push(...jobs);
    await sleep(200);
  }

  // Remotive is a secondary remote source. It never uses Browserbase.
  for (const query of ["software engineer", "software developer", "backend engineer"]) {
    candidates.push(...(await fetchRemotive(query)));
    await sleep(200);
  }

  return candidates;
}

async function main() {
  const profile = readJson(PROFILE_PATH, { name: "Unknown" });
  const rules = readJson(RULES_PATH, {});
  const existingQueue = readJson(QUEUE_PATH, []);

  const rawCandidates = await collectCandidates(rules);
  const seenUrls = new Set();
  const discovered = [];

  for (const candidate of rawCandidates) {
    const entry = toQueueEntry(candidate, rules);
    if (!entry) continue;

    const key = normalize(entry.posting_url);
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    discovered.push(entry);
  }

  const { merged, added } = dedupeAndMerge(existingQueue, discovered);
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(merged, null, 2));

  console.log(`\n🔎 Raw candidates fetched: ${rawCandidates.length}`);
  console.log(`✅ Matched target-role candidates: ${discovered.length}`);
  console.log(`🆕 New additions: ${added}`);
  console.log(`📋 Queue size: ${merged.length}`);
  console.log("☁️ Browserbase sessions used: 0");
  console.log(`Profile: ${profile.name}`);
}

module.exports = {
  normalize,
  canonicalUrl,
  looksLikeTargetTitle,
  fetchLever,
  fetchGreenhouse,
  fetchRemotive,
  toQueueEntry,
  dedupeAndMerge,
  collectCandidates
};

if (require.main === module) {
  main().catch(error => {
    console.error("\n❌ DISCOVERY ERROR:", error.message);
    process.exit(1);
  });
}
