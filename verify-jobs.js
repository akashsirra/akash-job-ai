const fs = require("fs");

const jobs = JSON.parse(fs.readFileSync("./jobs.json", "utf8"));

const verified = jobs.filter(job => {
  const title = (job.title || "").trim();
  const context = (job.context || []).join(" ");

  // Reject obvious Google/search-result content
  if (/^What is /i.test(title)) return false;
  if (/people also ask/i.test(context)) return false;
  if (/people also search/i.test(context)) return false;
  if (/job vacancies|search results|where to find/i.test(context)) return false;

  // Keep only entries that look like actual job postings
  const hasJobTitle =
    /software engineer|software developer|software development engineer|sde|developer|engineer trainee|apprentice/i.test(title);

  const hasCompany =
    job.context &&
    job.context.length >= 3 &&
    job.context[2] &&
    !/jobs|search|read more|people/i.test(job.context[2]);

  return hasJobTitle && hasCompany;
});

fs.writeFileSync(
  "verified-jobs.json",
  JSON.stringify(verified, null, 2)
);

console.log(`✅ ${verified.length} candidates passed initial verification\n`);

verified.forEach((job, index) => {
  console.log(`${index + 1}. ${job.title}`);
  console.log(`   ${job.context.join(" | ")}\n`);
});
