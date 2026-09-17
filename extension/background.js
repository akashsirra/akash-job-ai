const api = typeof browser !== "undefined" ? browser : chrome;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const processedPages = new Map();

async function getSettings() {
  return api.storage.local.get({
    groqApiKey: "",
    groqModel: DEFAULT_MODEL,
    profile: {},
    autoFillEnabled: false,
    autoAiEnabled: true
  });
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

async function generateAnswer(question, context, profile) {
  return groq([
    {
      role: "system",
      content: "You are a job application assistant. Use only facts present in the candidate profile. Never invent employers, degrees, dates, skills, achievements, authorization, salary, sponsorship, or work history. Return a concise answer suitable for a job application. If the profile does not contain enough information, return NEEDS_REVIEW."
    },
    {
      role: "user",
      content: `Candidate profile:\n${JSON.stringify(profile).slice(0, 12000)}\n\nJob/application context:\n${String(context || "").slice(0, 12000)}\n\nQuestion:\n${String(question || "").slice(0, 5000)}`
    }
  ]);
}

async function fillOpenQuestions(tabId, scanned, profile) {
  const candidates = scanned.fields
    .map((f, index) => ({ ...f, index }))
    .filter(f => {
      const key = `${f.label} ${f.name} ${f.id}`;
      if (/password|otp|verification|captcha|security|bank|card number|cvv|aadhaar|pan number/i.test(key)) return false;
      if (f.value) return false;
      return f.tag === "textarea" || ((f.type === "text" || f.type === "search") && f.required);
    });

  let generated = 0;
  let review = 0;
  for (const field of candidates) {
    try {
      const answer = await generateAnswer(field.label || field.name, scanned.page.text, profile);
      if (!answer || answer.trim() === "NEEDS_REVIEW") {
        review++;
        continue;
      }
      const fill = await api.tabs.sendMessage(tabId, { type: "FILL_FIELD", index: field.index, value: answer.trim() });
      if (fill?.ok) generated++; else review++;
    } catch (_) {
      review++;
    }
  }
  return { generated, review };
}

async function autoFillPage(tabId, url) {
  const settings = await getSettings();
  if (!settings.autoFillEnabled || !settings.profile || (!settings.profile.name && !settings.profile.email)) return null;
  const key = `${tabId}:${url}`;
  if (processedPages.get(key)) return null;
  processedPages.set(key, true);

  // Give dynamic application forms a moment to render.
  await new Promise(resolve => setTimeout(resolve, 500));
  try {
    const basic = await api.tabs.sendMessage(tabId, { type: "FILL_BASIC", profile: settings.profile });
    const scanned = await api.tabs.sendMessage(tabId, { type: "SCAN_PAGE" });
    let ai = { generated: 0, review: 0 };
    if (settings.autoAiEnabled && settings.groqApiKey) {
      ai = await fillOpenQuestions(tabId, scanned, settings.profile);
    }
    await api.storage.local.set({
      lastAutoFill: {
        url,
        title: scanned.page.title,
        timestamp: Date.now(),
        basicFilled: basic?.filled?.length || 0,
        aiFilled: ai.generated,
        needsReview: ai.review
      }
    });
    return { basic, ai, page: scanned.page };
  } catch (error) {
    processedPages.delete(key);
    return { error: error.message };
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "PAGE_READY" && sender.tab?.id) {
    return autoFillPage(sender.tab.id, message.url || sender.tab.url);
  }

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
