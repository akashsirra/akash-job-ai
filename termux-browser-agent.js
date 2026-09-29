#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const queue = fs.existsSync("./job-queue.json") ? JSON.parse(fs.readFileSync("./job-queue.json","utf8")) : [];

const NEVER = /password|passcode|otp|one[- ]time|verification|captcha|security code|resume|cv upload|cover letter|signature/i;
const FINAL = /^(submit|submit application|send application|finish application|complete application|apply now|send my application)$/i;
const NEXT = /^(next|continue|continue application|save and continue|next step|review application|review and submit|proceed|go to next|save & continue)$/i;
const APPLY = /^(apply|apply now|apply for this job|start application|easy apply)$/i;

function sh(args) {
  const r = spawnSync("tbp", ["--json", ...args], { encoding:"utf8", timeout:60000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "tbp failed").trim());
  const raw = (r.stdout || "").trim();
  try { return JSON.parse(raw); } catch { return raw; }
}
function text(args) { const r=sh(args); return typeof r==="string"?r:(r?.text ?? r?.result ?? JSON.stringify(r)); }
function evalJs(js) { const r=sh(["eval",js]); if(typeof r==="string"){try{return JSON.parse(r)}catch{return r}} return r?.result ?? r; }
function norm(v){return String(v??"").replace(/\\s+/g," ").trim().toLowerCase();}
function profileValue(f){
  const k=norm([f.label,f.name,f.id,f.placeholder,f.autocomplete].join(" "));
  const parts=String(profile.name||"").trim().split(/\\s+/);
  const e=profile.education||{};
  if(/first.*name|given.*name/.test(k)) return parts[0]||null;
  if(/last.*name|family.*name|surname/.test(k)) return parts.slice(1).join(" ")||null;
  if(/full.*name|your name/.test(k)) return profile.name||null;
  if(/e-?mail/.test(k)) return profile.email||null;
  if(/phone|mobile|contact number/.test(k)) return profile.phone||null;
  if(/linkedin/.test(k)) return profile.linkedin||null;
  if(/github/.test(k)) return profile.github||null;
  if(/portfolio|personal site|website/.test(k)) return profile.portfolio||null;
  if(/\\bcity\\b/.test(k)) return profile.city||profile.location||null;
  if(/\\bstate\\b|province/.test(k)) return profile.state||null;
  if(/postal|zip/.test(k)) return profile.postal_code||null;
  if(/country/.test(k)) return profile.country||"India";
  if(/graduation year|passing year/.test(k)) return profile.graduation_year ?? e.graduation_year ?? null;
  if(/university|college|institution/.test(k)) return profile.university||e.university||null;
  if(/degree|qualification/.test(k)) return profile.degree||e.degree||null;
  if(/notice period/.test(k)) return profile.notice_period||null;
  if(/expected.*salary|expected.*ctc/.test(k)) return profile.expected_salary||null;
  return null;
}
function selector(f){
  if(f.id) return "#"+String(f.id).replace(/\\/g,"\\\\").replace(/"/g,'\\\"');
  if(f.name) return '[name="'+String(f.name).replace(/\\/g,"\\\\").replace(/"/g,'\\\"')+'"]';
  return null;
}
function getFields(){
  return evalJs(`(() => {
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"};
    return [...document.querySelectorAll("input,textarea,select")].filter(e=>visible(e)&&!e.disabled).map(e=>({
      tag:e.tagName.toLowerCase(),type:e.type||"",name:e.name||"",id:e.id||"",
      label:e.labels?.[0]?.innerText?.trim()||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"",
      placeholder:e.placeholder||"",autocomplete:e.autocomplete||"",required:!!(e.required||e.getAttribute("aria-required")==="true"),readOnly:!!e.readOnly,
      options:e.tagName.toLowerCase()==="select"?[...e.options].map(o=>({text:o.textContent.trim(),value:o.value})):[]}));
  })()`);
}
function controls(regex){
  return evalJs(`(() => {
    const re=new RegExp(${JSON.stringify(regex.source)},"i");
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"};
    const label=e=>(e.innerText||e.textContent||e.getAttribute("aria-label")||e.getAttribute("title")||"").replace(/\\\\s+/g," ").trim();
    return [...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].filter(visible).map(e=>({text:label(e),href:e.closest("a")?.href||e.href||""})).filter(x=>x.text&&re.test(x.text));
  })()`);
}
function clickText(t){
  return evalJs(`(() => {
    const wanted=${JSON.stringify(t)};
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"};
    const label=e=>(e.innerText||e.textContent||e.getAttribute("aria-label")||e.getAttribute("title")||"").replace(/\\\\s+/g," ").trim();
    const e=[...document.querySelectorAll("a,button,[role=button],input[type=button],input[type=submit]")].find(x=>visible(x)&&label(x).toLowerCase()===wanted.toLowerCase());
    if(!e)return false;e.scrollIntoView({block:"center"});e.click();return true;
  })()`);
}
function fill(f,v){
  const s=selector(f); if(!s)return false;
  return !!evalJs(`(() => {
    const e=document.querySelector(${JSON.stringify(s)}); if(!e)return false;
    const v=${JSON.stringify(String(v))};
    if(e.tagName==="SELECT"){const o=[...e.options].find(x=>x.value.toLowerCase()===v.toLowerCase()||x.textContent.trim().toLowerCase()===v.toLowerCase());if(!o)return false;e.value=o.value;e.dispatchEvent(new Event("change",{bubbles:true}));return true;}
    const proto=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set; e.focus(); if(setter)setter.call(e,v);else e.value=v;
    e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true;
  })()`);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function main(){
  const requested=process.argv.find(x=>x.startsWith("--job="))?.slice(6).toLowerCase();
  const jobs=queue.filter(j=>j.application_status!=="applied"&&j.status!=="rejected"&&(j.posting_url||j.official_url));
  let job=requested?jobs.find(j=>norm(j.company+" "+j.title).includes(requested)):jobs.find(j=>j.status==="verified")||jobs[0];
  if(!job) throw new Error("No job in job-queue.json with a posting URL.");
  const url=job.posting_url||job.official_url;
  console.log(`\\n🤖 TERMUX NATIVE JOB AGENT\\n\\n${job.company} — ${job.title}\\n${url}\\n`);
  sh(["goto",url]); await sleep(4000);

  for(let step=1;step<=12;step++){
    console.log(`🔎 Step ${step}: ${text(["eval","location.href"])}`);
    const fields=getFields(); let filled=[], skipped=[];
    for(const f of fields){
      const key=norm([f.label,f.name,f.id,f.placeholder,f.autocomplete].join(" "));
      if(NEVER.test(key)){skipped.push({...f,reason:"sensitive_or_upload"});continue}
      if(f.readOnly){skipped.push({...f,reason:"readonly"});continue}
      const v=profileValue(f);
      if(v==null||v===""){if(f.required)skipped.push({...f,reason:"no_mapped_value"});continue}
      if(/^(checkbox|radio)$/i.test(f.type)){skipped.push({...f,reason:"choice_requires_explicit_answer"});continue}
      if(fill(f,v))filled.push({...f,value:v}); else if(f.required)skipped.push({...f,reason:"fill_failed"});
    }
    if(filled.length)console.log(`✅ Filled ${filled.length} field(s)`);

    const final=controls(FINAL); if(final.length){
      fs.writeFileSync("application-draft.json",JSON.stringify({prepared_at:new Date().toISOString(),company:job.company,title:job.title,application_url:text(["eval","location.href"]),fields_filled:filled,fields_skipped:skipped,final_submission:"NOT PERFORMED"},null,2));
      console.log(`🛑 FINAL SUBMIT DETECTED: ${final[0].text}`);
      console.log("💾 application-draft.json saved. YOU must review and submit.");
      return;
    }
    const required=skipped.filter(x=>x.required);
    if(required.length){
      fs.writeFileSync("application-draft.json",JSON.stringify({prepared_at:new Date().toISOString(),company:job.company,title:job.title,application_url:text(["eval","location.href"]),fields_filled:filled,fields_skipped:skipped,unknown_required_fields:required,final_submission:"NOT PERFORMED"},null,2));
      console.log(`🛑 ${required.length} required field(s) need explicit answers.`);
      return;
    }
    const next=controls(NEXT); if(next.length){clickText(next[0].text);await sleep(2500);continue;}
    const apply=controls(APPLY); if(apply.length&&step===1){clickText(apply[0].text);await sleep(3500);continue;}
    console.log("🛑 No unambiguous next/apply action found. Stopping.");
    fs.writeFileSync("application-draft.json",JSON.stringify({prepared_at:new Date().toISOString(),company:job.company,title:job.title,application_url:text(["eval","location.href"]),fields_filled:filled,fields_skipped:skipped,final_submission:"NOT PERFORMED"},null,2));
    return;
  }
}
main().catch(e=>{console.error("\n❌ "+e.message);process.exit(1)});
