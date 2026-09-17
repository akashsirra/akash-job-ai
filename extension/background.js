const api = typeof browser !== "undefined" ? browser : chrome;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

async function getSettings() {
  return api.storage.local.get({ groqApiKey: "", groqModel: DEFAULT_MODEL });
}

async function groq(messages, json = false) {
  const { groqApiKey, groqModel } = await getSettings();
  if (!groqApiKey) throw new Error("Add your Groq API key in ApplyPilot Settings first.");
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqApiKey}` },
    body: JSON.stringify({
      model: groqModel || DEFAULT_MODEL,
      temperature: 0.2,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {})
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Groq request failed (${response.status})`);
  return data.choices?.[0]?.message?.content || "";
}

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "GENERATE_ANSWER") {
    const question = String(message.question || "").slice(0, 5000);
    const context = String(message.context || "").slice(0, 12000);
    const profile = JSON.stringify(message.profile || {}).slice(0, 12000);
    return groq([
      { role: "system", content: "You are a job application assistant. Use only facts present in the candidate profile. Never invent employers, degrees, dates, skills, achievements, or authorization. Return a concise answer suitable for a job application. If the profile does not contain enough information, return NEEDS_REVIEW." },
      { role: "user", content: `Candidate profile:\n${profile}\n\nJob/application context:\n${context}\n\nQuestion:\n${question}` }
    ]).then(answer => ({ ok: true, answer })).catch(error => ({ ok: false, error: error.message }));
  }

  if (message?.type === "ANALYZE_FORM") {
    const fields = JSON.stringify(message.fields || []).slice(0, 16000);
    const job = String(message.jobText || "").slice(0, 12000);
    const profile = JSON.stringify(message.profile || {}).slice(0, 10000);
    return groq([
      { role: "system", content: "Map application fields to candidate profile keys. Never invent data. Return JSON: {\"mappings\":[{\"index\":number,\"profileKey\":string|null,\"confidence\":number,\"needsAI\":boolean}]} . Only map factual profile fields; open-ended questions should have needsAI=true." },
      { role: "user", content: `Profile:\n${profile}\n\nJob page:\n${job}\n\nFields:\n${fields}` }
    ], true).then(raw => ({ ok: true, data: JSON.parse(raw) })).catch(error => ({ ok: false, error: error.message }));
  }

  return false;
});
