require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");

async function main() {
  const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));
  const job = queue[0];

  if (!job.posting_url) {
    throw new Error("No posting_url found in job-queue.json");
  }

  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID
  });

  console.log("☁️ Browserbase session created");

  const browser = await puppeteer.connect({
    browserWSEndpoint: session.connectUrl
  });

  const page = await browser.newPage();

  await page.goto(job.posting_url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  const data = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 12000),
    links: [...document.querySelectorAll("a")]
      .map(a => ({
        text: (a.innerText || "").trim(),
        href: a.href
      }))
      .filter(x => x.text && x.href)
  }));

  console.log("\n🌐 FINAL URL:");
  console.log(data.url);

  console.log("\n📄 PAGE TITLE:");
  console.log(data.title);

  console.log("\n🔗 LINKS:");
  data.links.slice(0, 30).forEach((x, i) => {
    console.log(`${i + 1}. ${x.text}`);
    console.log(`   ${x.href}`);
  });

  console.log("\n📋 JOB PAGE TEXT:");
  console.log(data.text);

  const officialLink = data.links.find(x =>
    x.href.includes("careers.qualcomm.com")
  );

  queue[0].description = data.text;
  queue[0].official_url = officialLink ? officialLink.href : queue[0].official_url;
  queue[0].status = officialLink ? "verified" : "needs_review";

  fs.writeFileSync(
    "./job-queue.json",
    JSON.stringify(queue, null, 2)
  );

  console.log("\n💾 Job description saved to job-queue.json");
  console.log("Official application:", queue[0].official_url || "Not found");

  await browser.close();

  console.log("\n✅ Posting inspection complete.");
  console.log("Browserbase sessions used: 1");
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  process.exit(1);
});
