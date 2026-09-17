const fs = require("fs");

const DRAFT_FILE = "./application-draft.json";
const QUEUE_FILE = "./job-queue.json";

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

if (!process.argv.includes("--confirm")) {
  fail("This only marks an application after you have submitted it manually. Re-run with --confirm after the real submission.");
}

if (!fs.existsSync(DRAFT_FILE)) fail("application-draft.json not found. Run npm run prepare first.");
if (!fs.existsSync(QUEUE_FILE)) fail("job-queue.json not found.");

const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, "utf8"));
const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));

const index = queue.findIndex(job =>
  (draft.official_url && job.official_url === draft.official_url) ||
  (draft.title && draft.company && job.title === draft.title && job.company === draft.company)
);

if (index === -1) fail("Could not find the prepared job in job-queue.json. Nothing was changed.");

const now = new Date().toISOString();
queue[index] = {
  ...queue[index],
  application_status: "applied",
  applied_at: now,
  application_url: draft.application_url || queue[index].application_url || null
};

fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
fs.writeFileSync(DRAFT_FILE, JSON.stringify({
  ...draft,
  marked_applied_at: now,
  final_submission: "MANUALLY CONFIRMED BY USER"
}, null, 2));

console.log("\n✅ Marked application as applied.");
console.log("Company:", queue[index].company);
console.log("Role:", queue[index].title);
console.log("Applied at:", now);
console.log("Final submission was not automated by Akash Job AI.");
