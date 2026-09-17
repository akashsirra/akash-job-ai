const api = typeof browser !== "undefined" ? browser : chrome;
const ids = ["key","model","name","email","phone","linkedin","github","portfolio","city","state","country","university","degree","year","skills","projects"];
const $ = id => document.getElementById(id);

async function load() {
  const data = await api.storage.local.get({ groqApiKey: "", groqModel: "llama-3.3-70b-versatile", profile: {} });
  $("key").value = data.groqApiKey;
  $("model").value = data.groqModel;
  const p = data.profile || {};
  $("name").value = p.name || ""; $("email").value = p.email || ""; $("phone").value = p.phone || "";
  $("linkedin").value = p.linkedin || ""; $("github").value = p.github || ""; $("portfolio").value = p.portfolio || "";
  $("city").value = p.city || ""; $("state").value = p.state || ""; $("country").value = p.country || "India";
  $("university").value = p.university || p.education?.university || "";
  $("degree").value = p.degree || p.education?.degree || "";
  $("year").value = p.graduation_year || p.education?.graduation_year || "";
  $("skills").value = Array.isArray(p.skills) ? p.skills.join(", ") : typeof p.skills === "object" ? Object.values(p.skills).flat().join(", ") : (p.skills || "");
  $("projects").value = Array.isArray(p.projects) ? p.projects.join(", ") : (p.projects || "");
}

$("save").addEventListener("click", async () => {
  const profile = {
    name: $("name").value.trim(), email: $("email").value.trim(), phone: $("phone").value.trim(),
    linkedin: $("linkedin").value.trim(), github: $("github").value.trim(), portfolio: $("portfolio").value.trim(),
    city: $("city").value.trim(), state: $("state").value.trim(), country: $("country").value.trim(),
    university: $("university").value.trim(), degree: $("degree").value.trim(), graduation_year: $("year").value ? Number($("year").value) : "",
    skills: $("skills").value.split(",").map(x => x.trim()).filter(Boolean),
    projects: $("projects").value.split(",").map(x => x.trim()).filter(Boolean)
  };
  await api.storage.local.set({ groqApiKey: $("key").value.trim(), groqModel: $("model").value.trim(), profile });
  $("status").textContent = " Saved ✓"; $("status").className = "ok";
});
load();
