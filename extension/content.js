(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const sensitive = /password|passcode|otp|one[- ]time|verification|captcha|security code|credit card|card number|cvv|bank|ssn|aadhaar|pan number/i;

  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();

  function labelFor(el) {
    if (el.labels?.[0]) return clean(el.labels[0].innerText);
    return clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.name || el.id);
  }

  function readPage() {
    const heading = clean(document.querySelector("h1")?.innerText || document.title);
    const description = clean([
      ...document.querySelectorAll("meta[name='description'], meta[property='og:description']")
    ].map(x => x.content).join(" "));
    const body = clean(document.body?.innerText || "");
    return {
      url: location.href,
      title: heading.slice(0, 300),
      description: description.slice(0, 2000),
      text: body.slice(0, 18000)
    };
  }

  function detectFields() {
    return [...document.querySelectorAll("input, textarea, select")]
      .filter(el => visible(el) && !el.disabled)
      .map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || "text",
        name: el.name || "",
        id: el.id || "",
        label: labelFor(el),
        placeholder: el.placeholder || "",
        autocomplete: el.autocomplete || "",
        required: !!(el.required || el.getAttribute("aria-required") === "true"),
        value: el.value || "",
        options: el.tagName === "SELECT" ? [...el.options].map(o => ({ text: clean(o.textContent), value: o.value })) : []
      }));
  }

  function dispatch(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setValue(el, value) {
    if (el.readOnly || el.disabled) return false;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, String(value)); else el.value = String(value);
    dispatch(el);
    return true;
  }

  function fillBasic(profile) {
    const p = profile || {};
    const parts = String(p.name || "").trim().split(/\s+/);
    const values = {
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
      name: p.name || "",
      email: p.email || "",
      phone: p.phone || "",
      linkedin: p.linkedin || "",
      github: p.github || "",
      portfolio: p.portfolio || "",
      city: p.city || "",
      state: p.state || "",
      country: p.country || "India",
      postal: p.postal_code || "",
      university: p.university || p.education?.university || "",
      degree: p.degree || p.education?.degree || "",
      graduationYear: p.graduation_year || p.education?.graduation_year || ""
    };
    const filled = [], skipped = [];
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!visible(el) || el.disabled || sensitive.test(labelFor(el) + " " + el.name + " " + el.id)) continue;
      const key = (labelFor(el) + " " + el.name + " " + el.id + " " + el.autocomplete).toLowerCase();
      let value = null;
      if (/first.?name|given.?name/.test(key)) value = values.firstName;
      else if (/last.?name|family.?name|surname/.test(key)) value = values.lastName;
      else if (/full.?name|your name/.test(key)) value = values.name;
      else if (/e.?mail/.test(key)) value = values.email;
      else if (/phone|mobile|contact number/.test(key)) value = values.phone;
      else if (/linkedin/.test(key)) value = values.linkedin;
      else if (/github/.test(key)) value = values.github;
      else if (/portfolio|personal site|website/.test(key)) value = values.portfolio;
      else if (/\bcity\b/.test(key)) value = values.city;
      else if (/\bstate\b|province/.test(key)) value = values.state;
      else if (/\bcountry\b/.test(key)) value = values.country;
      else if (/postal|zip/.test(key)) value = values.postal;
      else if (/university|college|institution/.test(key)) value = values.university;
      else if (/degree|qualification/.test(key)) value = values.degree;
      else if (/graduation year|passing year/.test(key)) value = values.graduationYear;
      if (value !== null && value !== "") {
        if (el.tagName === "SELECT") {
          const target = String(value).toLowerCase();
          const option = [...el.options].find(o => o.value.toLowerCase() === target || clean(o.textContent).toLowerCase() === target || clean(o.textContent).toLowerCase().includes(target));
          if (option) { el.value = option.value; dispatch(el); filled.push(labelFor(el)); }
        } else if (setValue(el, value)) filled.push(labelFor(el));
      }
    }
    return { filled, skipped };
  }

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "SCAN_PAGE") return Promise.resolve({ page: readPage(), fields: detectFields() });
    if (message?.type === "FILL_BASIC") return Promise.resolve(fillBasic(message.profile));
    if (message?.type === "FILL_FIELD") {
      const fields = detectFields();
      const f = fields[message.index];
      if (!f) return Promise.resolve({ ok: false, error: "Field no longer exists" });
      const els = [...document.querySelectorAll("input, textarea, select")].filter(el => visible(el) && !el.disabled);
      if (sensitive.test(f.label + " " + f.name + " " + f.id)) return Promise.resolve({ ok: false, error: "Sensitive field blocked" });
      return Promise.resolve({ ok: setValue(els[message.index], message.value) });
    }
    return false;
  });

  // Tell the background script whenever a new document or SPA route is ready.
  // This lets ApplyPilot refill the next application page after the candidate
  // presses the site's own Next/Continue button, without submitting anything.
  let lastReadyUrl = "";
  function announcePage() {
    if (location.href === lastReadyUrl) return;
    lastReadyUrl = location.href;
    api.runtime.sendMessage({ type: "PAGE_READY", url: location.href }).catch(() => {});
  }
  const originalPush = history.pushState;
  history.pushState = function (...args) {
    const result = originalPush.apply(this, args);
    setTimeout(announcePage, 250);
    return result;
  };
  const originalReplace = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplace.apply(this, args);
    setTimeout(announcePage, 250);
    return result;
  };
  window.addEventListener("popstate", () => setTimeout(announcePage, 250));
  window.addEventListener("hashchange", () => setTimeout(announcePage, 250));
  setTimeout(announcePage, 300);
})();
