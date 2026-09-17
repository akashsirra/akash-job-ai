require("dotenv").config();

const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

async function main() {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
  });

  console.log("Session created:", session.id);

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl,
  });

  const page = await browser.newPage();

  await page.goto("https://example.com", {
    waitUntil: "domcontentloaded",
  });

  console.log("TITLE:", await page.title());
  console.log("HEADING:", await page.$eval("h1", el => el.innerText));

  await browser.close();

  console.log("Browserbase test PASSED 🚀");
}

main().catch(error => {
  console.error("TEST FAILED:", error.message);
  process.exit(1);
});
