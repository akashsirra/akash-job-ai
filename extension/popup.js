const api = typeof browser !== "undefined" ? browser : chrome;
const $ = id => document.getElementById(id);

async function activeTab(){ const tabs=await api.tabs.query({active:true,currentWindow:true}); return tabs[0]; }
async function send(tabId,message){ return api.tabs.sendMessage(tabId,message); }
async function settings(){ return api.storage.local.get({profile:{},autoFillEnabled:false,autoAiEnabled:true}); }
async function profile(){ const data=await settings(); return data.profile||{}; }

async function scan(){
  const tab=await activeTab();
  if(!tab?.id) throw new Error("No active tab.");
  const result=await send(tab.id,{type:"SCAN_PAGE"});
  $("count").textContent=result.fields.length;
  await api.storage.local.set({lastScan:result});
  $("status").textContent=`Found ${result.fields.length} fields on:\n${result.page.title||result.page.url}`;
  return result;
}

async function refreshAutoButton(){
  const s=await settings();
  $("auto").textContent=`Page-by-page mode: ${s.autoFillEnabled?"ON ✓":"OFF"}`;
  $("auto").className=s.autoFillEnabled?"on":"secondary";
}

$("scan").addEventListener("click",async()=>{try{await scan();}catch(e){$("status").textContent=`Scan failed: ${e.message}`;}});

$("fill").addEventListener("click",async()=>{
  try{
    const tab=await activeTab(),p=await profile();
    if(!p.name&&!p.email)throw new Error("Add your profile in Settings first.");
    const result=await send(tab.id,{type:"FILL_BASIC",profile:p});
    $("status").textContent=`Filled ${result.filled.length} known fields.\n${result.filled.join("\n")||"Nothing mapped yet."}`;
    await scan();
  }catch(e){$("status").textContent=`Fill failed: ${e.message}`;}
});

$("aiFill").addEventListener("click",async()=>{
  try{
    const tab=await activeTab(),p=await profile();
    if(!p.name&&!p.email)throw new Error("Add your profile in Settings first.");
    const scanned=await send(tab.id,{type:"SCAN_PAGE"});
    const candidates=scanned.fields.map((f,index)=>({...f,index})).filter(f=>/textarea/i.test(f.tag)||(/text|search/i.test(f.type)&&f.required));
    let generated=0,review=0;
    for(const field of candidates){
      if(/password|otp|verification|captcha|security|bank|card number|cvv|aadhaar|pan/i.test(field.label+" "+field.name))continue;
      const r=await api.runtime.sendMessage({type:"GENERATE_ANSWER",question:field.label||field.name,context:scanned.page.text,profile:p});
      if(!r?.ok){review++;continue;}
      if(r.answer&&r.answer!=="NEEDS_REVIEW"){
        const fill=await send(tab.id,{type:"FILL_FIELD",index:field.index,value:r.answer});
        if(fill?.ok)generated++;else review++;
      }else review++;
    }
    $("status").textContent=`AI filled ${generated} open questions.\n${review?`${review} need your review.`:"All eligible questions handled."}`;
    await scan();
  }catch(e){$("status").textContent=`AI fill failed: ${e.message}`;}
});

$("auto").addEventListener("click",async()=>{
  const s=await settings();
  const enabled=!s.autoFillEnabled;
  await api.storage.local.set({autoFillEnabled:enabled});
  await refreshAutoButton();
  $("status").textContent=enabled
    ? "Page-by-page mode ON. ApplyPilot will fill each new application page after navigation. It will not click Submit."
    : "Page-by-page mode OFF.";
});

$("settings").addEventListener("click",()=>api.runtime.openOptionsPage());

refreshAutoButton();
scan().catch(e=>{$("status").textContent=`Open an application page, then scan.\n${e.message}`;});
