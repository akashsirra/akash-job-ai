const fs = require("fs");
const { execSync } = require("child_process");

const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));

console.log("\n🤖 AKASH JOB AI — PROFILE\n");
console.log("Name:", profile.name || "AKASH SIRRA");

if (!queue.length) {
  console.log("No jobs in queue.");
  process.exit(0);
}

const job = queue[0];

console.log("\n🎯 MATCHING ACTUAL QUEUED JOB\n");
console.log("Title:", job.title);
console.log("Company:", job.company);
console.log("Location:", job.location);
console.log("Status:", job.status);
console.log("Official URL:", job.official_url || "Not verified");

const matcherSource = fs.readFileSync("./matcher.js", "utf8");

const functionStart = matcherSource.indexOf("function matchJob");
const functionEnd = matcherSource.indexOf("\nconst testJob");

if (functionStart === -1 || functionEnd === -1) {
  throw new Error("Could not load matchJob() from matcher.js");
}

const functionCode = matcherSource.slice(functionStart, functionEnd);

const helperCode = `
function normalize(value) {
  return String(value || "").toLowerCase();
}

function getProfileText() {
  return JSON.stringify(profile).toLowerCase();
}
`;

const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

eval(`
${helperCode}
${functionCode}
`);

const result = matchJob(job);

console.log("\n📊 MATCH RESULT\n");
console.log(JSON.stringify(result, null, 2));

if (job.official_url) {
  console.log("\n🔗 OFFICIAL APPLICATION:");
  console.log(job.official_url);
}

if (result.missingSkills.length) {
  console.log("\n⚠️ MISSING PROFILE SKILLS:");
  result.missingSkills.forEach(skill => console.log("-", skill));
}

console.log("\n✅ Matching complete.");
