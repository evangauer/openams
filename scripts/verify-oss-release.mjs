// Checks Git-tracked files before anything is pushed to the public repository.
// Reports only the file and rule, never the matching value.
//
// Real customer and prospect names must never be published, so they can't live in
// this repository either. Maintainers keep them in an untracked file (one name per
// line) and point OSS_RELEASE_DENYLIST at it; CI runs without it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenArchiveExtensions = new Set([
  ".7z",
  ".backup",
  ".dump",
  ".gz",
  ".sqlite",
  ".tgz",
  ".zip",
]);
const sensitiveContentRules = [
  { name: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack webhook", pattern: /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/ },
  { name: "Stripe secret key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/ },
  { name: "Vercel access token", pattern: /\bvercel_[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: "Google service-account key",
    test: (content) =>
      /"type"\s*:\s*"service_account"/.test(content) && /"private_key"\s*:/.test(content),
  },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Resend API key", pattern: /\bre_[A-Za-z0-9]{20,}\b/ },
  { name: "SendGrid API key", pattern: /\bSG\.[\w-]{16,}\.[\w-]{16,}/ },
];
const forbiddenFileNames = [
  { name: "service-account key file", pattern: /serviceaccount.*\.json$/i },
  { name: "Firebase Admin SDK key file", pattern: /-firebase-adminsdk-.*\.json$/i },
];

const denylistPath = process.env.OSS_RELEASE_DENYLIST;
const deniedTerms = denylistPath
  ? readFileSync(denylistPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  : [];

const findings = [];
for (const file of tracked) {
  const name = basename(file);
  if (name.startsWith(".env") && name !== ".env.example") {
    findings.push({ file, rule: "tracked environment file" });
  }
  if (forbiddenArchiveExtensions.has(extname(name).toLowerCase())) {
    findings.push({ file, rule: "tracked archive or database export" });
  }
  for (const rule of forbiddenFileNames) {
    if (rule.pattern.test(name)) findings.push({ file, rule: rule.name });
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of sensitiveContentRules) {
    const matched = rule.test ? rule.test(content) : rule.pattern.test(content);
    if (matched) findings.push({ file, rule: rule.name });
  }
  const lowered = content.toLowerCase();
  deniedTerms.forEach((term, index) => {
    if (lowered.includes(term.toLowerCase())) {
      findings.push({ file, rule: `denylisted term #${index + 1}` });
    }
  });
}

const requiredPublicFiles = [
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
];
const trackedSet = new Set(tracked);
for (const file of requiredPublicFiles) {
  if (!trackedSet.has(file)) findings.push({ file, rule: "required public file missing" });
}

if (findings.length > 0) {
  console.error("Open-source release verification failed:");
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`);
  process.exit(1);
}

const denylistNote = denylistPath ? `, ${deniedTerms.length} denylisted terms` : ", no denylist";
console.log(`Open-source release verification passed (${tracked.length} tracked files${denylistNote}).`);
