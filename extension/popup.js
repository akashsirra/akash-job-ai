const api = typeof browser !== "undefined" ? browser : chrome;
const $ = id => document.getElementById(id);

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function send(tabId, message) {
  return api.tabs.sendMessage(tabId, message);
}

async function profile() {
  const data = await api.storage.local.get("profile");
  return data.profile || {};
}

async function scan() {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("No active tab.");
  const result = await send(tab.id, { type: "SCAN_PAGE" });
  $("count").textContent = result.fields.length;
  await api.storage.local.set({ lastScan: result });
  $("status").textContent = `Found ${result.fields.length} fields on:\n${result.page.title || result.page.url}`;
  return result;
}

$("scan").addEventListener("click", async () => {
  try { await scan(); } catch (e) { $("status").textContent = `Scan failed: ${e.message}`; }
});

$("fill").addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const p = await profile();
    if (!p.name && !p.email) throw new Error("Add your profile in Settings first.");
    const result = await send(tab.id, { type: "FILL_BASIC", profile: p });
    $("status").textContent = `Filled ${result.filled.length} known fields.\n${result.filled.join("\n") || "Nothing mapped yet."}`;
    await scan();
  } catch (e) { $("status").textContent = `Fill failed: ${e.message}`; }
});

$("settings").addEventListener("click", () => api.runtime.openOptionsPage());

scan().catch(e => { $("status").textContent = `Open an application page, then scan.\n${e.message}`; });
