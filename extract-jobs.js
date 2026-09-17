const fs = require("fs");

const text = fs.readFileSync("./search-results.txt", "utf8");

const lines = text
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean);

const jobs = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (
    /software engineer|software developer|developer|sde|graduate engineer|trainee/i.test(line)
  ) {
    jobs.push({
      title: line,
      context: lines.slice(Math.max(0, i - 1), i + 4)
    });
  }
}

const uniqueJobs = jobs.filter(
  (job, index, self) =>
    index === self.findIndex(j => j.title === job.title)
);

fs.writeFileSync(
  "jobs.json",
  JSON.stringify(uniqueJobs.slice(0, 30), null, 2)
);

console.log(`✅ Found ${uniqueJobs.length} possible job entries`);
console.log("📄 Saved to jobs.json");
console.log("\nFirst entries:\n");

console.log(
  JSON.stringify(uniqueJobs.slice(0, 5), null, 2)
);
