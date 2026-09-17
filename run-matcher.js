const fs = require("fs");
const { matchJob } = require("./matcher.js");

const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));

console.log("\n🤖 AKASH JOB AI — QUEUE MATCHING\n");
console.log("Profile:", profile.name || "AKASH SIRRA");
console.log("Queued jobs:", queue.length);

if (!queue.length) {
  console.log("No jobs in queue.");
  process.exit(0);
}

let candidates = 0;

for (const [index, job] of queue.entries()) {
  const result = matchJob(job);
  if (result.eligible) candidates += 1;

  console.log(`\n${index + 1}. ${job.title}`);
  console.log(`   Company: ${job.company}`);
  console.log(`   Location: ${job.location}`);
  console.log(`   Queue status: ${job.status}`);
  console.log(`   Match: ${result.status} | eligible=${result.eligible} | score=${result.matchScore}`);
  console.log(`   Role: ${result.roleMatch} | Location: ${result.locationMatch} | Fresher: ${result.fresherSignal}`);
  console.log(`   Skills: ${result.skillMatches.length ? result.skillMatches.join(", ") : "none"}`);
  if (result.rejectedReason) console.log(`   Reason: ${result.rejectedReason}`);
  if (job.posting_url || job.official_url) console.log(`   URL: ${job.posting_url || job.official_url}`);
}

console.log(`\n🎯 Eligible candidates: ${candidates}`);
console.log("\n✅ Matching complete. No Browserbase session was created.");
