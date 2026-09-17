require("dotenv").config();

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

  const elements = await page.evaluate(() => {
    return [...document.querySelectorAll("div")]
      .filter(el => {
        const text = el.innerText || "";
        return /Software Engineer|Software Developer/i.test(text);
      })
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        className: el.className,
        text: (el.innerText || "").slice(0, 500)
      }));
  });

  console.log(JSON.stringify(elements, null, 2));

  await browser.close();
}

main().catch(error => {
  console.error("INSPECT ERROR:", error.message);
  process.exit(1);
});
