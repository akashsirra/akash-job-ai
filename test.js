const { execFileSync } = require("child_process");
const fs = require("fs");

const files = [
  "discover-jobs.js",
  "inspect-posting.js",
  "matcher.js",
  "prepare-application.js",
  "mark-applied.js",
  "pipeline.js",
  "classify-job-status.js"
];

for (const file of files) {
  if (!fs.existsSync(file)) throw new Error(`Missing test target: ${file}`);
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  console.log(`✅ syntax: ${file}`);
}

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const verify = pkg.scripts?.verify || "";
if (!verify.includes("node inspect-posting.js")) {
  throw new Error("npm run verify is not wired to inspect-posting.js");
}
if (!verify.includes("classify-job-status.js")) {
  throw new Error("npm run verify is not wired to classify-job-status.js");
}
if (pkg.scripts?.["mark-applied"] !== "node mark-applied.js") {
  throw new Error("npm run mark-applied is not wired to mark-applied.js");
}

console.log("\n✅ AKASH JOB AI local smoke tests passed.");
console.log("No Browserbase session was created by these tests.");
