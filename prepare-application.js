require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const Browserbase = require("@browserbasehq/sdk");
const { matchJob } = require("./matcher");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

const STOP_BEFORE_SUBMIT = rules.application_policy?.stop_before_final_submission !== false;
const NEVER_FILL = /password|otp|verification code|captcha|resume|cv upload|cover letter|signature/i;
const FINAL_RE = /^(submit|submit application|send application|finish application|complete application|apply now|send my application)$/i;
const NEXT_RE = /^(next|continue|continue application|save and continue|next step|review application|review and submit|proceed|go to next|save & continue)$/i;
const APPLY_RE = /^(apply|apply now|apply for this job|start application|easy apply)$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function keyOf(f) { return `${f.label || ""} ${f.name || ""} ${f.id || ""} ${f.placeholder || ""} ${f.autocomplete || ""}`.toLowerCase(); }
function norm(v) { return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase(); }
function selector(f) {
  const esc = String(f.id || f.name || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return esc ? `[${f.id ? "id" : "name"}="${esc}"]` : null;
}

function profileValue(f) {
  const k = keyOf(f), p = String(profile.name || "").trim().split(/\s+/), e = profile.education || {};
  if (/first.*name|given.*name/.test(k)) return p[0] || null;
  if (/last.*name|family.*name|surname/.test(k)) return p.slice(1).join(" ") || null;
  if (/full.*name|your name/.test(k)) return profile.name || null;
  if (/e-?mail/.test(k)) return profile.email || null;
  if (/phone|mobile|contact number/.test(k)) return profile.phone || null;
  if (/linkedin/.test(k)) return profile.linkedin || null;
  if (/github/.test(k)) return profile.github || null;
  if (/portfolio|personal site|website/.test(k)) return profile.portfolio || null;
  if (/\bcity\b/.test(k)) return profile.city || null;
  if (/\bstate\b|province/.test(k)) return profile.state || null;
  if (/postal|zip/.test(k)) return profile.postal_code || null;
  if (/country/.test(k)) return profile.country || null;
  if (/graduation year|passing year/.test(k)) return profile.graduation_year ?? e.graduation_year ?? null;
  if (/university|college|institution/.test(k)) return profile.university || e.university || null;
  if (/degree|qualification/.test(k)) return profile.degree || e.degree || null;
  if (/notice period/.test(k)) return profile.notice_period || null;
  if (/expected.*salary|expected.*ctc/.test(k)) return profile.expected_salary || null;
  return null;
}

function detectAdapter(url) {
  try {
    const u = new URL(url), h = u.hostname.toLowerCase(), p = u.pathname.toLowerCase();
    if (/careers\/job\//.test(p) && /eightfold|qualcomm|careers\./.test(h)) return "eightfold";
    if (h.includes("greenhouse.io")) return "greenhouse";
    if (h.includes("lever.co")) return "lever";
    if (h.includes("ashbyhq.com")) return "ashby";
    if (h.includes("myworkdayjobs.com") || h.includes("workday.com")) return "workday";
    return "generic";
  } catch { return "generic"; }
}

function adapterUrl(url) {
  try {
    const u = new URL(url), adapter = detectAdapter(url);
    if (adapter === "eightfold") {
      const pid = u.pathname.split("/").filter(Boolean).pop();
      if (/^\d+$/.test(pid)) return `${u.origin}/careers/apply?pid=${encodeURIComponent(pid)}`;
    }
    if (adapter === "greenhouse") {
      const m = u.pathname.match(/\/jobs\/(\d+)/i);
      if (m) return `${u.origin}/embed/job_app?for=${u.hostname.split(".")[0]}&token=${m[1]}`;
    }
    if (adapter === "lever") return url.replace(/\/?$/, "/apply");
    return null;
  } catch { return null; }
}

async function inspect(page) {
  for (const frame of page.frames()) {
    try {
      const fields = await frame.evaluate(() => {
        const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        return [...document.querySelectorAll("input,textarea,select")].filter(el => visible(el) && !el.disabled).map(el => ({
          tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "",
          label: el.labels?.[0]?.innerText?.trim() || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "",
          placeholder: el.placeholder || "", autocomplete: el.autocomplete || "",
          required: !!(el.required || el.getAttribute("aria-required") === "true"), readOnly: !!el.readOnly,
          options: el.tagName.toLowerCase() === "select" ? [...el.options].map(o => ({ text: o.textContent.trim(), value: o.value })) : []
        }));
      });
      if (fields.length) return { frame, fields };
    } catch {}
  }
  return { frame: null, fields: [] };
}

async function controls(page, regex) {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(source => {
        const re = new RegExp(source, "i"), visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        return [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].filter(visible).map(el => ({ text: text(el), href: el.closest("a")?.href || el.href || "" })).filter(x => x.text && re.test(x.text));
      }, regex.source);
      if (found.length) return { frame, found };
    } catch {}
  }
  return { frame: null, found: [] };
}

async function fill(frame, fields) {
  const filled = [], skipped = [];
  for (const f of fields) {
    const k = keyOf(f);
    if (NEVER_FILL.test(k)) { skipped.push({ ...f, reason: "sensitive_or_file_upload" }); continue; }
    if (f.readOnly) { skipped.push({ ...f, reason: "readonly" }); continue; }
    const value = profileValue(f);
    if (value == null || value === "") { if (f.required) skipped.push({ ...f, reason: "no_mapped_value" }); continue; }
    const sel = selector(f);
    if (!sel) { if (f.required) skipped.push({ ...f, reason: "no_selector" }); continue; }
    try {
      const h = await frame.$(sel);
      if (!h) { skipped.push({ ...f, reason: "selector_not_found" }); continue; }
      if (f.tag === "select") {
        const target = norm(value), option = (f.options || []).find(o => norm(o.value) === target || norm(o.text) === target || norm(o.text).includes(target) || target.includes(norm(o.text)));
        if (!option) { skipped.push({ ...f, reason: "no_matching_option" }); await h.dispose(); continue; }
        await h.select(option.value); filled.push({ ...f, value: option.text });
      } else if (/^(checkbox|radio)$/i.test(f.type)) skipped.push({ ...f, reason: "choice_requires_explicit_profile_value" });
      else { await h.click({ clickCount: 3 }).catch(() => {}); await h.press("Backspace").catch(() => {}); await h.type(String(value), { delay: 8 }); filled.push({ ...f, value }); }
      await h.dispose();
    } catch (e) { skipped.push({ ...f, reason: `fill_error: ${e.message}` }); }
  }
  return { filled, skipped };
}

async function main() {
  const arg = process.argv.slice(2).find(x => x.startsWith("--job="));
  const requested = arg ? arg.slice(6).toLowerCase() : null;
  const candidates = queue.filter(j => j.official_url && j.status === "verified" && j.application_status !== "applied" && matchJob(j).eligible);
  const candidate = requested ? candidates.find(j => `${j.company} ${j.title}`.toLowerCase().includes(requested)) : candidates[0];
  if (!candidate) { console.log("No verified eligible job is ready for application preparation."); return; }
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");

  console.log("\n📝 PREPARING APPLICATION\n");
  console.log("Company:", candidate.company); console.log("Role:", candidate.title); console.log("URL:", candidate.official_url);
  console.log("🧩 Application adapter:", detectAdapter(candidate.official_url));

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
  let page = await browser.newPage();
  const debug = await bb.sessions.debug(session.id).catch(() => null);
  const liveViewUrl = debug?.debuggerFullscreenUrl || debug?.debuggerUrl || null;
  const allFilled = [], allSkipped = [];
  let applicationUrl = candidate.official_url;

  try {
    await page.goto(candidate.official_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(5000);
    let target = adapterUrl(candidate.official_url);
    if (target) console.log("🧭 Direct application route:", target);
    if (!target) {
      const apply = await controls(page, APPLY_RE);
      target = apply.found[0]?.href || null;
      if (target) console.log("🔗 Apply link:", target);
    }
    if (target && target !== page.url()) {
      const next = await browser.newPage();
      await next.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(5000);
      page = next;
    }
    applicationUrl = page.url();

    for (let step = 1; step <= 10; step++) {
      const { frame, fields } = await inspect(page);
      console.log(`🔎 Application step ${step}: ${fields.length} form fields`);
      if (frame && fields.length) {
        const result = await fill(frame, fields);
        allFilled.push(...result.filled); allSkipped.push(...result.skipped);
      }
      const final = await controls(page, FINAL_RE);
      if (final.found.length) { console.log("🛑 Final submission control detected:", final.found[0].text); break; }
      const next = await controls(page, NEXT_RE);
      if (!next.found.length) break;
      const before = page.url();
      await next.frame.evaluate(text => {
        const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
        const label = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x => visible(x) && label(x) === text);
        if (el) el.click();
      }, next.found[0].text);
      await sleep(3000);
      if (page.url() === before && step === 10) break;
    }

    const unknownRequired = allSkipped.filter(f => f.required);
    fs.writeFileSync("application-draft.json", JSON.stringify({ prepared_at: new Date().toISOString(), company: candidate.company, title: candidate.title, official_url: candidate.official_url, application_url: applicationUrl, live_view_url: liveViewUrl, fields_filled: allFilled, fields_skipped: allSkipped, unknown_required_fields: unknownRequired, final_submission: "NOT PERFORMED" }, null, 2));
    console.log(`\n📋 Application URL: ${applicationUrl}`);
    console.log(`✅ Fields filled live: ${allFilled.length}`);
    console.log(`⚠️ Fields skipped: ${allSkipped.length} (of which required: ${unknownRequired.length})`);
    if (unknownRequired.length) unknownRequired.forEach(f => console.log(`   - ${f.label || f.name || f.id} (${f.reason})`));
    console.log("💾 Saved application-draft.json");
    console.log("\n🛑 Final submission was NOT performed.");
    if (liveViewUrl) console.log("Live view:", liveViewUrl);
    console.log("After you submit manually: npm run mark-applied -- --confirm");
    if (STOP_BEFORE_SUBMIT) await new Promise(() => {});
  } finally {
    if (!STOP_BEFORE_SUBMIT) await browser.close();
  }
}

main().catch(e => { console.error("\n❌ APPLICATION PREPARATION ERROR:", e.message); process.exit(1); });
