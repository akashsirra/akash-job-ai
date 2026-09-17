const fs = require("fs");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
  return /\b(fresher|freshers|entry[- ]level|graduate|new grad|early career|trainee|0\s*[-–]\s*1\s*years?)\b/i.test(text);
}

function matchJob(job) {
  const text = normalize(
    `${job.title || ""} ${job.location || ""} ${job.description || ""} ${(job.source_context || []).join(" ")}`
  );

  const title = normalize(job.title || "");
  const roleMatch = (rules.target_roles || []).some(role =>
    title.includes(normalize(role))
  );

  const locationMatch = (rules.locations || []).some(location =>
    text.includes(normalize(location))
  );

  const rejected = (rules.reject_if || []).find(reason =>
    text.includes(normalize(reason))
  );

  const maxYears = Number(rules.experience?.max_years ?? 1);
  const detectedExperienceYears = experienceYears(text);
  const fresherSignal = hasFresherSignal(text);
  const overExperience =
    detectedExperienceYears !== null &&
    detectedExperienceYears > maxYears &&
    !fresherSignal;

  const profileSkills = flattenProfileSkills(profile);
  const preferredSkills = (rules.preferred_skills || []).map(normalize);
  const jobSkillsMentioned = preferredSkills.filter(skill => text.includes(skill));
  const skillMatches = jobSkillsMentioned.filter(skill =>
    profileSkills.includes(skill)
  );

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
    (fresherSignal && skillMatches.length >= 1)
  ) {
    status = "candidate";
  }

  const matchScore = jobSkillsMentioned.length
    ? Math.round((skillMatches.length / jobSkillsMentioned.length) * 100)
    : 0;

  return {
    eligible: status === "candidate",
    status,
    roleMatch,
    locationMatch,
    fresherSignal,
    detectedExperienceYears,
    skillMatches,
    missingPreferredSkills: jobSkillsMentioned.filter(
      skill => !skillMatches.includes(skill)
    ),
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
