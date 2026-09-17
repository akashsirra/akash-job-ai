const { spawnSync } = require("child_process");
const fs = require("fs");

const steps = {
  discover: "discover-jobs.js",
  verify: "inspect-posting.js",
  match: "matcher.js",
  prepare: "prepare-application.js",
  "mark-applied": "mark-applied.js"
};

function run(step) {
  const file = steps[step];
  if (!file) throw new Error(`Unknown step: ${step}`);
  const result = spawnSync(process.execPath, [file, ...process.argv.slice(3)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const command = process.argv[2] || "status";

if (command === "status") {
  const queue = fs.existsSync("./job-queue.json")
    ? JSON.parse(fs.readFileSync("./job-queue.json", "utf8"))
    : [];
  const verified = queue.filter(x => x.status === "verified").length;
  const applied = queue.filter(x => x.application_status === "applied").length;
  const waiting = queue.filter(x => x.status !== "verified").length;
  const candidates = queue.filter(x => x.status === "verified" && x.application_status !== "applied").length;

  console.log("\n🤖 AKASH JOB AI\n");
  console.log(`Queue: ${queue.length}`);
  console.log(`Verified: ${verified}`);
  console.log(`Ready / not applied: ${candidates}`);
  console.log(`Applied: ${applied}`);
  console.log(`Waiting for verification: ${waiting}`);
  console.log("\nCommands:");
  console.log("  npm run discover      # one Browserbase session: find fresh links");
  console.log("  npm run verify        # one Browserbase session: verify one job");
  console.log("  npm run match         # local: match every queued job");
  console.log("  npm run prepare       # one Browserbase session: prepare one application");
  console.log("  npm run mark-applied -- --confirm  # after you manually submit");
  console.log("  npm test              # local syntax/config smoke tests; no Browserbase");
  console.log("\nFinal submission is intentionally never automated.");
} else if (command === "all") {
  run("discover");
  run("verify");
  run("match");
} else if (steps[command]) {
  run(command);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
