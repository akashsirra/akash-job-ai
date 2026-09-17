require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

async function main() {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID
  });

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl
  });

  const page = await browser.newPage();

  await page.goto(
    "https://www.google.com/search?q=software+engineer+jobs+Hyderabad+freshers",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  const text = await page.evaluate(() => document.body.innerText);

  fs.writeFileSync(
    "search-results.txt",
    text,
    "utf8"
  );

  console.log("✅ Job search completed");
  console.log("📄 Saved results to search-results.txt");

  await browser.close();
}

main().catch(error => {
  console.error("JOB FINDER ERROR:", error.message);
  process.exit(1);
});
