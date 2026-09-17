const fs = require("fs");

const jobs = JSON.parse(fs.readFileSync("./jobs.json", "utf8"));

const badPatterns = [
  /^What is /i,
  /^\d+ .* jobs in /i,
  /jobs in .* 202[0-9]/i,
  /job vacancies/i,
  /page navigation/i,
  /people also ask/i,
  /people also search/i,
  /find the best .* jobs/i,
  /where to find/i,
  /software engineer jobs.*202[0-9]/i
];

const rolePattern =
  /software engineer|software developer|software development engineer|sde|developer|engineer trainee|software engineer trainee|apprentice/i;

const cleaned = [];

for (const job of jobs) {
  const title = (job.title || "").trim();
  const context = job.context || [];
  const fullText = `${title} ${context.join(" ")}`;

  if (!rolePattern.test(title)) continue;
  if (badPatterns.some(pattern => pattern.test(title))) continue;
  if (badPatterns.some(pattern => pattern.test(fullText))) continue;

  // Google usually places the company immediately after the job title.
  const titleIndex = context.findIndex(x => x.trim() === title);

  if (titleIndex === -1) continue;

  const company = context[titleIndex + 1]?.trim();
  const location = context[titleIndex + 2]?.trim();

  if (!company || !location) continue;

  cleaned.push({
    title,
    company,
    location,
    source_context: context
  });
}

const unique = cleaned.filter(
  (job, index, array) =>
    index === array.findIndex(
      x => `${x.title}|${x.company}|${x.location}` ===
           `${job.title}|${job.company}|${job.location}`
    )
);

fs.writeFileSync(
  "clean-jobs.json",
  JSON.stringify(unique, null, 2)
);

console.log(`🤖 Clean Job Finder`);
console.log(`✅ ${unique.length} actual-looking candidates found`);
console.log(`📄 Saved: clean-jobs.json\n`);

unique.forEach((job, i) => {
  console.log(`${i + 1}. ${job.title}`);
  console.log(`   Company: ${job.company}`);
  console.log(`   Location: ${job.location}\n`);
});
