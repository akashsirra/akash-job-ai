const fs = require("fs");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));
const searchText = fs.readFileSync("./search-results.txt", "utf8");

const existingQueue = fs.existsSync("./job-queue.json")
  ? JSON.parse(fs.readFileSync("./job-queue.json", "utf8"))
  : [];

const lines = searchText
  .split("\n")
  .map(x => x.trim())
  .filter(Boolean);

const badTitle = [
  /^what /i,
  /^which /i,
  /^how /i,
  /jobs? in/i,
  /job vacancies/i,
  /search/i,
  /page navigation/i,
  /salary/i,
  /freshers$/i
];

const badContext = [
  /people also ask/i,
  /people also search/i,
  /page navigation/i,
  /read more/i,
  /\b\d{2,5}\s+open jobs?\b/i,
  /\bopen jobs? for\b/i,
  /\bjobs? for\b.*\b(estimate|salary)\b/i,
  /\bglassdoor est\b/i,
  /\bjob search\b/i,
  /\bsearch results\b/i,
  /\bcategory\b/i
];

const badExperience = [
  /\b[2-9]\+?\s*years?\b/i,
  /\b[2-9]\s*(?:-|to)\s*\d+\s*years?\b/i,
  /\b1[1-9]\+?\s*years?\b/i,
  /\b10\s*(?:-|to)\s*\d+\s*years?\b/i,
  /\b[2-9]\s*yrs?\b/i
];

const badSearchPage = [
  /\b\d{2,5}\s+open jobs?\b/i,
  /\bopen jobs? for\b/i,
  /\b\d{1,3}[,.]?\d{0,3}\s*(?:jobs|vacancies)\b/i,
  /\b(?:glassdoor|indeed|naukri|linkedin)\s+(?:search|jobs?)\b/i
];

const rolePattern = new RegExp(
  rules.target_roles
    .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "i"
);

const candidates = [];

for (let i = 0; i < lines.length; i++) {
  const title = lines[i];

  if (!rolePattern.test(title)) continue;
  if (badTitle.some(pattern => pattern.test(title))) continue;

  const company = lines[i + 1] || "";
  const location = lines[i + 2] || "";
  const context = lines.slice(i, i + 6);

  if (!company || !location) continue;

  const contextText = context.join(" ");

  if (badContext.some(pattern => pattern.test(contextText))) continue;

  // Reject explicit experience requirements above the user's 0–1 year target.
  if (badExperience.some(pattern => pattern.test(contextText))) continue;

  // Reject obvious aggregate/search pages rather than individual job postings.
  if (badSearchPage.some(pattern => pattern.test(title))) continue;

  candidates.push({
    title,
    company,
    location,
    source_context: context,
    status: "needs_verification",
    browserbase_required: true
  });
}

const discovered = candidates.filter((job, index, arr) =>
  index === arr.findIndex(x =>
    `${x.title}|${x.company}|${x.location}` ===
    `${job.title}|${job.company}|${job.location}`
  )
);

// Preserve information already discovered during verification.
const merged = discovered.map(job => {
  const existing = existingQueue.find(x =>
    `${x.title}|${x.company}|${x.location}` ===
    `${job.title}|${job.company}|${job.location}`
  );

  return existing ? { ...job, ...existing } : job;
});

// Preserve verified jobs even if the latest search doesn't rediscover them.
for (const existing of existingQueue) {
  if (
    existing.status === "verified" &&
    !merged.some(x =>
      `${x.title}|${x.company}|${x.location}` ===
      `${existing.title}|${existing.company}|${existing.location}`
    )
  ) {
    merged.push(existing);
  }
}

fs.writeFileSync(
  "./job-queue.json",
  JSON.stringify(merged, null, 2)
);

console.log("\n🤖 AKASH JOB AI\n");
console.log(`Profile: ${profile.name}`);
console.log(`Candidates queued: ${merged.length}`);
console.log("Browserbase sessions used: 0\n");

merged.forEach((job, i) => {
  console.log(`${i + 1}. ${job.title}`);
  console.log(`   ${job.company}`);
  console.log(`   ${job.location}`);

  if (job.status === "verified") {
    console.log("   ✅ Verified");
    console.log(`   🔗 ${job.official_url || "Official URL saved"}`);
  } else {
    console.log("   🔍 Needs verification");
  }

  console.log("");
});
