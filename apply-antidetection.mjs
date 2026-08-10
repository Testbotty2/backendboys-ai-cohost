// apply-antidetection.mjs — Anti-Detection Status & Verification Tool
//
// Anti-detection is now NATIVELY integrated into server.mjs.
// This script verifies that all anti-detection features are properly
// wired and reports their current status. No patching needed.

import fs from "node:fs";

const FILE = "server.mjs";

if (!fs.existsSync(FILE)) {
  console.error(`Cannot find ${FILE} — run this from the folder that contains server.mjs`);
  process.exit(1);
}

const src = fs.readFileSync(FILE, "utf8");

const checks = [
  { label: "fingerprint.mjs import", pattern: `from "./fingerprint.mjs"` },
  { label: "ENABLE_FINGERPRINT_SPOOFING config", pattern: "ENABLE_FINGERPRINT_SPOOFING" },
  { label: "ENABLE_HUMAN_DELAY config", pattern: "ENABLE_HUMAN_DELAY" },
  { label: "humanTypingDelay helper", pattern: "humanTypingDelay" },
  { label: "antidetectionInfo helper", pattern: "antidetectionInfo" },
  { label: "browserProfile in createAccount", pattern: "browserProfile:buildBrowserProfile(id)" },
  { label: "browserProfile on restore", pattern: "merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id)" },
  { label: "impersonatedFetch in fetchForAccount", pattern: "impersonatedFetch(account,url" },
  { label: "human delay in sendKick", pattern: 'if(source!=="manual" && source!=="test") await sleep(humanTypingDelay(' },
  { label: "human delay in sendKickIsolated", pattern: 'if(source!=="manual")await sleep(humanTypingDelay(' },
  { label: "humanizeChatFormatting in postKickChat", pattern: "humanizeChatFormatting(content)" },
  { label: "fingerprint in publicAccount", pattern: "fingerprint: account.browserProfile ? {" },
  { label: "antiDetection in status endpoint", pattern: "antiDetection:antidetectionInfo()" },
];

let allOk = true;
console.log("🔍 Anti-Detection Integration Verification\n");
for (const c of checks) {
  const ok = src.includes(c.pattern);
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${c.label}`);
}

console.log(`\n${allOk ? "✅ All anti-detection features are natively integrated." : "❌ Some features are missing — check above."}`);
process.exit(allOk ? 0 : 1);
