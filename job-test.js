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

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl,
  });

  const page = await browser.newPage();

  const url =
    "https://www.google.com/search?q=software+engineer+jobs+Hyderabad+freshers";

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("PAGE TITLE:", await page.title());
  console.log("BODY:", (await page.$eval("body", el => el.innerText)).slice(0, 1000));
  console.log("PAGE URL:", page.url());

  await browser.close();

  console.log("JOB SITE TEST PASSED 🚀");
}

main().catch(error => {
  console.error("TEST FAILED:", error.message);
  process.exit(1);
});
