const fs = require("fs");

const QUEUE_FILE = "./job-queue.json";

const CLOSED_PATTERNS = [
  /this job is no longer available/i,
  /job is no longer available/i,
  /this position is no longer available/i,
  /position is no longer available/i,
  /job has been filled/i,
  /position has been filled/i,
  /applications? (?:are|is) (?:now )?closed/i,
  /applications? (?:are|is) no longer being accepted/i,
  /no longer accepting applications/i,
  /job has expired/i,
  /job posting has expired/i,
  /requisition (?:has )?closed/i,
  /posting (?:has )?closed/i
];

function isClosed(job) {
  const text = [job.title, job.page_title, job.description, job.verification_error]
    .filter(Boolean)
    .join("\n");
  return CLOSED_PATTERNS.some(pattern => pattern.test(text));
}

if (!fs.existsSync(QUEUE_FILE)) {
  console.log("No job queue found.");
  process.exit(0);
}

const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
let changed = 0;

for (let i = 0; i < queue.length; i++) {
  const job = queue[i];
  if (job.application_status === "applied" || job.status === "closed") continue;
  if (!isClosed(job)) continue;

  queue[i] = {
    ...job,
    status: "closed",
    closed_at: new Date().toISOString(),
    verification_error: "Job posting is closed or no longer accepting applications"
  };
  changed++;
  console.log(`🚫 Marked closed: ${job.title} — ${job.company}`);
}

if (changed) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

console.log(`Closed-job scan complete. Marked closed: ${changed}`);
