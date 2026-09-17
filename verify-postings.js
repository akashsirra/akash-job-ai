require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

async function main() {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

  if (!queue.length) {
    console.log("No jobs waiting for verification.");
    return;
  }

  const job = queue[0];

  console.log("\n🤖 VERIFYING ONE JOB\n");
  console.log("Title:", job.title);
  console.log("Company:", job.company);
  console.log("Search location:", job.location);

  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID
  });

  console.log("\n☁️ Browserbase session created.");

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl
  });

  const page = await browser.newPage();

  const searchUrl =
    "https://www.google.com/search?q=" +
    encodeURIComponent(`"${job.title}" "${job.company}" Hyderabad`);

  console.log("Searching for original posting...");

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const results = await page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .map(a => ({
        text: (a.innerText || "").trim(),
        href: a.href
      }))
      .filter(x => x.text && x.href)
      .filter(x => !x.href.includes("google.com/search"))
      .slice(0, 40)
  );

  const relevant = results.filter(result => {
    const text = result.text.toLowerCase();

    return (
      text.includes(job.company.toLowerCase()) ||
      text.includes(job.title.toLowerCase())
    );
  });

  console.log("\n🔎 Possible original postings:");

  for (let i = 0; i < Math.min(relevant.length, 5); i++) {
    const result = relevant[i];

    console.log(`\n${i + 1}. ${result.text}`);
    console.log(`   Google result: ${result.href}`);

    try {
      const resultPage = await browser.newPage();

      await resultPage.goto(result.href, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log(`   REAL URL: ${resultPage.url()}`);

      await resultPage.close();
    } catch (error) {
      console.log(`   Could not resolve: ${error.message}`);
    }
  }

  await browser.close();

  console.log("\n✅ Verification discovery complete.");
  console.log("Browserbase sessions used in this run: 1");
}

main().catch(error => {
  console.error("\n❌ VERIFICATION ERROR:", error.message);
  process.exit(1);
});
