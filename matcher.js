const fs = require("fs");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenProfileSkills(data) {
  const skills = [];
  for (const value of Object.values(data.skills || {})) {
    if (Array.isArray(value)) skills.push(...value);
  }
  return [...new Set(skills.map(normalize).filter(Boolean))];
}

function experienceYears(text) {
  const re = /\b(\d+(?:\.\d+)?)\s*(?:\+|or more)?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience)?/ig;
  let max = null;
  for (const match of text.matchAll(re)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function hasFresherSignal(text) {
  return /\b(fresher|freshers|entry[- ]level|graduate|new grad|early career|trainee|campus|0\s*[-to]+\s*1\s*years?)\b/i.test(text);
}

function roleMatchesTitle(title) {
  const value = normalize(title);
  const patterns = [
    /\bsoftware\s+(?:engineer|developer)\b/i,
    /\bsoftware\s+development\s+engineer\b/i,
    /\b(?:sde|swe)\b/i,
    /\bbackend\s+(?:engineer|developer)\b/i,
    /\bfull[- ]?stack\s+(?:engineer|developer)\b/i,
    /\bgraduate\s+engineer\s+trainee\b/i,
    /\bsoftware\s+engineer\s+trainee\b/i,
    /\bsoftware\s+developer\s+trainee\b/i
  ];

  if (patterns.some(pattern => pattern.test(value))) return true;

  return (rules.target_roles || []).some(role => {
    const target = normalize(role);
    return value === target || value.startsWith(`${target} -`) || value.startsWith(`${target} |`);
  });
}

function locationMatches(text) {
  const value = normalize(text);
  const allowed = (rules.locations || []).map(normalize);

  if (allowed.includes("remote india") && /\bremote\b/.test(value) && /\bindia\b/.test(value)) {
    return true;
  }

  if (allowed.includes("bangalore") && /\b(?:bangalore|bengaluru)\b/.test(value)) return true;
  if (allowed.includes("hyderabad") && /\bhyderabad\b/.test(value)) return true;

  return allowed.some(location => value.includes(location));
}

function explicitExperienceTooHigh(text, maxYears) {
  const value = normalize(text);
  if (new RegExp(`\\b${maxYears + 1}\\s*[-+]?\\s*years?\\b`).test(value)) return true;
  if (/\b(?:2|3|4|5|6|7|8|9|10)\s*\+?\s*years?\b/i.test(value)) return true;

  const range = value.match(/\b(\d+)\s*[-to]+\s*(\d+)\s*years?\b/i);
  if (range && Number(range[1]) > maxYears) return true;

  return false;
}

function matchJob(job) {
  const text = normalize(
    `${job.title || ""} ${job.location || ""} ${job.description || ""} ${(job.source_context || []).join(" ")}`
  );

  const roleMatch = roleMatchesTitle(job.title || "");
  const locationMatch = locationMatches(text);

  const rejected = (rules.reject_if || []).find(reason => {
    const pattern = normalize(reason);
    if (pattern === "sales") return /\bsales\b/i.test(text);
    if (pattern === "unpaid internship") return /unpaid\s+internship/i.test(text);
    if (pattern === "ai training gig") return /ai\s+training|training\s+gig/i.test(text);
    if (pattern === "unrelated role") return /unrelated\s+role/i.test(text);
    return text.includes(pattern);
  });

  const maxYears = Number(rules.experience?.max_years ?? 1);
  const detectedExperienceYears = experienceYears(text);
  const fresherSignal = hasFresherSignal(text);
  const overExperience = explicitExperienceTooHigh(text, maxYears) ||
    (detectedExperienceYears !== null && detectedExperienceYears > maxYears && !fresherSignal);

  const profileSkills = flattenProfileSkills(profile);
  const preferredSkills = (rules.preferred_skills || []).map(normalize);
  const jobSkillsMentioned = preferredSkills.filter(skill => text.includes(skill));
  const skillMatches = jobSkillsMentioned.filter(skill => profileSkills.includes(skill));

  let status = "needs_review";
  let rejectedReason = null;

  if (rejected) {
    status = "rejected";
    rejectedReason = `Rejected rule matched: ${rejected}`;
  } else if (!roleMatch) {
    status = "rejected";
    rejectedReason = "Target role not detected";
  } else if (!locationMatch) {
    status = "rejected";
    rejectedReason = "Target location not detected";
  } else if (overExperience) {
    status = "rejected";
    rejectedReason = `Experience requirement exceeds ${maxYears} year`;
  } else if (
    skillMatches.length >= 2 ||
    (fresherSignal && skillMatches.length >= 1) ||
    (jobSkillsMentioned.length === 0 && fresherSignal)
  ) {
    status = "candidate";
  }

  const matchScore = jobSkillsMentioned.length
    ? Math.round((skillMatches.length / jobSkillsMentioned.length) * 100)
    : fresherSignal ? 50 : 0;

  return {
    eligible: status === "candidate",
    status,
    roleMatch,
    locationMatch,
    fresherSignal,
    detectedExperienceYears,
    skillMatches,
    missingPreferredSkills: jobSkillsMentioned.filter(skill => !skillMatches.includes(skill)),
    matchScore,
    rejectedReason
  };
}

module.exports = { matchJob };

if (require.main === module) {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
  console.log("\n🤖 AKASH JOB AI — REQUIREMENT MATCH\n");
  for (const job of queue) {
    console.log(JSON.stringify({
      title: job.title,
      company: job.company,
      match: matchJob(job)
    }, null, 2));
  }
}
