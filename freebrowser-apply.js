require("dotenv").config();

const fs = require("fs");
const { matchJob } = require("./matcher");

const BASE = process.env.FREEBROWSER_URL || "http://127.0.0.1:8765";
const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("./job-queue.json", "utf8"));

const NEVER_FILL = /password|passcode|otp|one[- ]time|verification|captcha|security code|resume|cv upload|cover letter|signature/i;
const FINAL_RE = /^(submit|submit application|send application|finish application|complete application|apply now|send my application)$/i;
const NEXT_RE = /^(next|continue|continue application|save and continue|next step|review application|review and submit|proceed|go to next|save & continue)$/i;
const APPLY_RE = /^(apply|apply now|apply for this job|start application|easy apply)$/i;

function norm(v) { return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase(); }
function keyOf(f) { return `${f.label || ""} ${f.name || ""} ${f.id || ""} ${f.placeholder || ""} ${f.autocomplete || ""}`.toLowerCase(); }
function selectorFor(f) {
  const attr = f.id ? "id" : f.name ? "name" : "";
  if (!attr) return null;
  const value = String(f[attr]).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attr}="${value}"]`;
}
function profileValue(f) {
  const k = keyOf(f);
  const parts = String(profile.name || "").trim().split(/\s+/);
  const e = profile.education || {};
  if (/first.*name|given.*name/.test(k)) return parts[0] || null;
  if (/last.*name|family.*name|surname/.test(k)) return parts.slice(1).join(" ") || null;
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

async function api(path, method = "GET", body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`FreeBrowser returned non-JSON from ${path}: ${text.slice(0, 300)}`); }
  if (!r.ok || data.ok === false) throw new Error(data.error || `FreeBrowser ${r.status} on ${path}`);
  return data;
}

async function evaluate(expression) {
  const data = await api("/evaluate", "POST", { script: expression });
  let result = data.result;
  try { return JSON.parse(result); } catch { return result; }
}

async function controls(regexSource) {
  return evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(regexSource)}, "i");
    const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=="none" && s.visibility!=="hidden"; };
    const text = el => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g," ").trim();
    return [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")]
      .filter(visible).map(el => ({text:text(el), href:el.closest("a")?.href || el.href || ""}))
      .filter(x => x.text && re.test(x.text));
  })()`);
}

async function clickText(text) {
  return evaluate(`(() => {
    const wanted=${JSON.stringify(text)};
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
    const label=el=>(el.innerText||el.textContent||el.getAttribute("aria-label")||el.getAttribute("title")||"").replace(/\\s+/g," ").trim();
    const el=[...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x=>visible(x)&&label(x).toLowerCase()===wanted.toLowerCase());
    if(!el)return {ok:false,error:"Visible control not found",text:wanted};
    el.scrollIntoView({block:"center",inline:"center"}); el.click();
    return {ok:true,text:label(el)};
  })()`);
}

async function inspectFields() {
  return evaluate(`(() => {
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
    return [...document.querySelectorAll("input,textarea,select")].filter(el=>visible(el)&&!el.disabled).map(el=>({
      tag:el.tagName.toLowerCase(),type:el.type||"",name:el.name||"",id:el.id||"",
      label:el.labels?.[0]?.innerText?.trim()||el.getAttribute("aria-label")||el.getAttribute("placeholder")||"",
      placeholder:el.placeholder||"",autocomplete:el.autocomplete||"",required:!!(el.required||el.getAttribute("aria-required")==="true"),readOnly:!!el.readOnly,
      options:el.tagName.toLowerCase()==="select"?[...el.options].map(o=>({text:o.textContent.trim(),value:o.value})):[]
    }));
  })()`);
}

async function fillField(f, value) {
  const sel = selectorFor(f);
  if (!sel) return { ok:false, reason:"no_selector" };
  return evaluate(`(() => {
    const el=document.querySelector(${JSON.stringify(sel)});
    if(!el)return {ok:false,reason:"not_found"};
    const value=${JSON.stringify(String(value))};
    const setter=Object.getOwnPropertyDescriptor(el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")?.set;
    if(el.tagName==="SELECT"){
      const target=value.toLowerCase().trim();
      const option=[...el.options].find(o=>o.value.toLowerCase().trim()===target||o.textContent.toLowerCase().trim()===target||o.textContent.toLowerCase().includes(target)||target.includes(o.textContent.toLowerCase().trim()));
      if(!option)return {ok:false,reason:"no_matching_option"};
      el.value=option.value; el.dispatchEvent(new Event("change",{bubbles:true})); return {ok:true,value:option.textContent.trim()};
    }
    if(el.isContentEditable){el.textContent=value;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));el.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,value};}
    el.focus(); if(setter)setter.call(el,value); else el.value=value; el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));el.blur(); return {ok:true,value};
  })()`);
}

async function wait(ms) { await new Promise(r => setTimeout(r, ms)); }

async function main() {
  const arg = process.argv.find(x => x.startsWith("--job="));
  const requested = arg ? norm(arg.slice(6)) : null;
  const candidates = queue.filter(j => j.application_status !== "applied" && j.status !== "rejected" && (j.posting_url || j.official_url))
    .map(j => ({job:j, match:matchJob(j)})).filter(x => x.match.eligible)
    .sort((a,b) => b.match.matchScore-a.match.matchScore);
  const selected = requested ? candidates.find(x => norm(`${x.job.company} ${x.job.title}`).includes(requested)) : candidates[0];
  if (!selected) throw new Error("No eligible queued job found. Run discovery/verification/matching first.");

  const job = selected.job;
  const startUrl = job.posting_url || job.official_url;
  console.log(`🤖 FreeBrowser Apply\n\n${job.company} — ${job.title}\n${startUrl}\n`);
  const status = await api("/status");
  console.log(`🌐 FreeBrowser: ${status.browserAttached ? "connected" : "not attached"}`);
  await api("/open", "POST", { url:startUrl });
  await wait(4000);

  for (let step=1; step<=12; step++) {
    const current = (await api("/status")).url;
    console.log(`\n🔎 Step ${step}: ${current}`);
    let fields = await inspectFields();
    const filled = [], skipped = [];
    for (const f of fields) {
      const k=keyOf(f);
      if (NEVER_FILL.test(k)) { skipped.push({...f,reason:"sensitive_or_file_upload"}); continue; }
      if (f.readOnly) { skipped.push({...f,reason:"readonly"}); continue; }
      const value=profileValue(f);
      if (value == null || value === "") { if(f.required) skipped.push({...f,reason:"no_mapped_value"}); continue; }
      if (/^(checkbox|radio)$/i.test(f.type)) { skipped.push({...f,reason:"choice_requires_explicit_profile_value"}); continue; }
      const result=await fillField(f,value);
      if(result.ok) filled.push({...f,value:result.value ?? value}); else if(f.required) skipped.push({...f,reason:result.reason});
    }
    if(filled.length) console.log(`✅ Filled ${filled.length} field(s)`);
    const finalControls=await controls(FINAL_RE.source);
    const requiredUnknown=skipped.filter(x=>x.required);
    if(finalControls.length || requiredUnknown.length){
      const draft={prepared_at:new Date().toISOString(),company:job.company,title:job.title,posting_url:startUrl,application_url:(await api("/status")).url,match:selected.match,fields_filled:filled,fields_skipped:skipped,unknown_required_fields:requiredUnknown,final_submission:"NOT PERFORMED"};
      fs.writeFileSync("application-draft.json",JSON.stringify(draft,null,2));
      if(finalControls.length) console.log(`🛑 Final submission control detected: ${finalControls[0].text}`);
      if(requiredUnknown.length) console.log(`🛑 ${requiredUnknown.length} required field(s) need an explicit answer.`);
      console.log("💾 Saved application-draft.json");
      console.log("👤 Human action required for final submission / unknown answers.");
      return;
    }

    const nextControls=await controls(NEXT_RE.source);
    if(nextControls.length){
      await clickText(nextControls[0].text);
      await wait(2500);
      continue;
    }

    const applyControls=await controls(APPLY_RE.source);
    if(applyControls.length && step===1){
      await clickText(applyControls[0].text);
      await wait(3500);
      continue;
    }

    const draft={prepared_at:new Date().toISOString(),company:job.company,title:job.title,posting_url:startUrl,application_url:(await api("/status")).url,match:selected.match,fields_filled:filled,fields_skipped:skipped,unknown_required_fields:requiredUnknown,final_submission:"NOT PERFORMED"};
    fs.writeFileSync("application-draft.json",JSON.stringify(draft,null,2));
    console.log("ℹ️ No unambiguous Next/Apply control found; stopped safely.");
    console.log("💾 Saved application-draft.json");
    return;
  }
  throw new Error("Application exceeded 12 steps; stopped to avoid looping.");
}

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
