const fs = require("fs");

const profile = JSON.parse(fs.readFileSync("./profile.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("./job-rules.json", "utf8"));

function normalize(value) {
  return String(value || "").toLowerCase();
}

function profileText() {
  return JSON.stringify(profile).toLowerCase();
}

// Core mandatory requirements detected from job descriptions.
// These are deliberately separate from preferred_skills in job-rules.json.
const mandatoryRequirements = [
  ["C Programming", ["c programming", "c language"]],
  ["Memory Management", ["memory management"]],
  ["Pointers", ["pointers"]],
  ["Structures", ["structures"]],
  ["Data Structures", ["data structures"]],
  ["Algorithms", ["algorithms"]],
  ["Python", ["python"]],
  ["Shell Scripting", ["shell scripting", "shell script"]],
  ["Operating Systems", ["operating systems", "os internals"]],
  ["Processes", ["processes"]],
  ["Threads", ["threads"]],
  ["Synchronization", ["synchronization"]],
  ["Scheduling", ["scheduling"]],
  ["Interrupts", ["interrupts"]],
  ["Embedded Systems", ["embedded systems", "embedded software"]],
  ["Computer Architecture", ["computer architecture"]],
  ["ARM Architecture", ["arm architecture", "armv8", "armv9"]],
  ["Microprocessors", ["microprocessors", "microprocessor"]],
  ["Bit Manipulation", ["bit manipulation"]],
  ["Binary Arithmetic", ["binary arithmetic"]],
  ["Boolean Logic", ["boolean logic"]],
  ["Low-Level Programming", ["low-level programming", "low level programming"]],
  ["Git", ["git"]],
  ["Version Control", ["version control"]],
  ["Secure Coding", ["secure coding"]],
  ["Software Quality", ["software quality", "quality principles"]]
];

function requirementMentioned(text, aliases) {
  return aliases.some(alias => text.includes(alias));
}

function profileHasRequirement(profile, aliases) {
  const text = profileText();

  return aliases.some(alias => {
    if (text.includes(alias)) return true;

    // Related evidence from the resume/profile.
    if (
      alias === "software quality" ||
      alias === "quality principles"
    ) {
      return (
        text.includes("testing") ||
        text.includes("regression testing") ||
        text.includes("debugging")
      );
    }

    if (alias === "version control") {
      return text.includes("git") || text.includes("github");
    }

    return false;
  });
}

function matchJob(job) {
  const jobText = normalize(
    `${job.title || ""} ${job.location || ""} ${
      job.description || ""
    } ${job.source_context || ""}`
  );

  const roleMatch = rules.target_roles.some(role =>
    jobText.includes(normalize(role))
  );

  const locationMatch = rules.locations.some(location =>
    jobText.includes(normalize(location))
  );

  const rejected = rules.reject_if.find(reason =>
    jobText.includes(normalize(reason))
  );

  const detectedMandatory = mandatoryRequirements.filter(
    ([, aliases]) => requirementMentioned(jobText, aliases)
  );

  const directMatches = detectedMandatory
    .filter(([name, aliases]) => {
      const text = profileText();

      if (
        name === "Version Control" &&
        (text.includes("git") || text.includes("github"))
      ) {
        return true;
      }

      return aliases.some(alias => text.includes(alias));
    })
    .map(([name]) => name);

  const relatedEvidence = detectedMandatory
    .filter(([name]) =>
      name === "Software Quality" &&
      ["testing", "regression testing", "debugging"]
        .some(x => profileText().includes(x))
    )
    .map(([name]) => name)
    .filter(name => !directMatches.includes(name));

  const missingSkills = detectedMandatory
    .map(([name]) => name)
    .filter(name =>
      !directMatches.includes(name) &&
      !relatedEvidence.includes(name)
    );

  const totalMandatory = detectedMandatory.length;

  const matchScore =
    totalMandatory === 0
      ? 0
      : Math.round((directMatches.length / totalMandatory) * 100);

  const strongMatch = matchScore >= 70;

  let status = "needs_review";

  if (rejected) {
    status = "rejected";
  } else if (!roleMatch || !locationMatch) {
    status = "rejected";
  } else if (totalMandatory === 0) {
    status = "needs_review";
  } else if (strongMatch) {
    status = "candidate";
  }

  return {
    eligible: status === "candidate",
    status,
    roleMatch,
    locationMatch,
    mandatoryRequirementsDetected: totalMandatory,
    directMatches,
    relatedEvidence,
    missingSkills,
    matchScore,
    directCoverage: `${directMatches.length}/${totalMandatory}`,
    rejectedReason: rejected || null
  };
}

module.exports = { matchJob };

if (require.main === module) {
  const queue = JSON.parse(
    fs.readFileSync("./job-queue.json", "utf8")
  );

  if (!queue.length) {
    console.log("No jobs in queue.");
    process.exit(0);
  }

  console.log(
    "\n🤖 AKASH JOB AI — REQUIREMENT MATCH\n"
  );

  console.log(JSON.stringify(matchJob(queue[0]), null, 2));
}
