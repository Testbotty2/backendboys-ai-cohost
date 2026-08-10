// apply-antidetection.mjs — Anti-Bot Stealth + Cyberpunk HUD Visual Upgrade
import fs from "node:fs";

const FILE = "server.mjs";
const BACKUP = "server.mjs.bak";
const L = (...lines) => lines.join("\n");

const patches = [
  {
    name: "1/10 import fingerprint module",
    find: `import { Pool } from "pg";`,
    replace: L(
      `import { Pool } from "pg";`,
      `import { buildBrowserProfile, impersonatedFetch, tlsImpersonationStatus, describeFingerprint, calculateHumanTypingDelay } from "./fingerprint.mjs";`
    ),
    guard: `from "./fingerprint.mjs";`
  },
  {
    name: "2/10 anti-detection config + helpers",
    find: L(
      `if (!SESSION_SECRET) {`,
      `  console.warn("WARNING: SESSION_SECRET is not set.");`,
      `}`
    ),
    replace: L(
      `if (!SESSION_SECRET) {`,
      `  console.warn("WARNING: SESSION_SECRET is not set.");`,
      `}`,
      ``,
      `// ---- Anti-detection / fingerprint spoofing config ----`,
      `const ENABLE_FINGERPRINT_SPOOFING = String(process.env.ENABLE_FINGERPRINT_SPOOFING || "true").toLowerCase() !== "false";`,
      `const ENABLE_HUMAN_DELAY = String(process.env.ENABLE_HUMAN_DELAY || "true").toLowerCase() !== "false";`,
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
      `function humanTypingDelay(content = "", profile = null) {`,
      `  if (!ENABLE_HUMAN_DELAY) return 0;`,
      `  return calculateHumanTypingDelay(content, profile);`,
      `}`,
      `function antidetectionInfo() {`,
      `  return {`,
      `    enabled: ENABLE_FINGERPRINT_SPOOFING,`,
      `    humanDelayEnabled: ENABLE_HUMAN_DELAY,`,
      `    tls: tlsImpersonationStatus()`,
      `  };`,
      `}`
    ),
    guard: `const ENABLE_FINGERPRINT_SPOOFING`
  },
  {
    name: "3/10 per-account browser profile (createAccount base)",
    find: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),',
    replace: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),\n    browserProfile:buildBrowserProfile(id),',
    guard: `browserProfile:buildBrowserProfile(id),`
  },
  {
    name: "4/10 keep profile on restore",
    find: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);`,
    replace: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);\n  merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`,
    guard: `merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`
  },
  {
    name: "5/10 route all Kick fetches through impersonatedFetch",
    find: L(
      `  const agent=proxyAgentForAccount(account);`,
      `  try{`,
      `    const response=agent?await nodeFetch(url,{...options,agent}):await fetch(url,options);`
    ),
    replace: L(
      `  const agent=proxyAgentForAccount(account);`,
      `  try{`,
      `    const response=await impersonatedFetch(account,url,{...options,agent},{`,
      `      proxyUrl:proxyUrlForAccount(account),`,
      `      profile:account.browserProfile`,
      `    });`
    ),
    guard: `await impersonatedFetch(account,url`
  },
  {
    name: "6/10 human delay in sendKick",
    find: L(
      `  const id=broadcasterId(req); if(!id) throw new Error("Resolve the broadcaster ID first.");`,
      `  const result=await postKickChat(account,t.access_token,id,content,replyToMessageId);`
    ),
    replace: L(
      `  const id=broadcasterId(req); if(!id) throw new Error("Resolve the broadcaster ID first.");`,
      `  if(source!=="manual" && source!=="test") await sleep(humanTypingDelay(content, account?.browserProfile));`,
      `  const result=await postKickChat(account,t.access_token,id,content,replyToMessageId);`
    ),
    guard: `if(source!=="manual" && source!=="test") await sleep(humanTypingDelay(`
  },
  {
    name: "7/10 human delay in sendKickIsolated",
    find: `    const t=await refreshAccountTokenServer(account.slot);const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    replace: `    const t=await refreshAccountTokenServer(account.slot);if(source!=="manual")await sleep(humanTypingDelay(content, account?.browserProfile));const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    guard: `if(source!=="manual")await sleep(humanTypingDelay(`
  },
  {
    name: "8/10 expose fingerprint in publicAccount",
    find: `    badgeState:badgeStateForAccount(account),`,
    replace: L(
      `    badgeState:badgeStateForAccount(account),`,
      `    fingerprint: account.browserProfile ? {`,
      `      short: describeFingerprint(account.browserProfile),`,
      `      userAgent: account.browserProfile.userAgent,`,
      `      platform: account.browserProfile.platform,`,
      `      chromeMajor: account.browserProfile.chromeMajor,`,
      `      typingWpm: account.browserProfile.typingWpm,`,
      `      acceptLanguage: account.browserProfile.acceptLanguage,`,
      `      secChUa: account.browserProfile.secChUa,`,
      `      screen: account.browserProfile.screen,`,
      `      timezone: account.browserProfile.timezone,`,
      `      tls: tlsImpersonationStatus()`,
      `    } : null,`
    ),
    guard: `fingerprint: account.browserProfile ? {`
  },
  {
    name: "9/10 status endpoint + startup log",
    find: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),`,
    replace: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),\n    antidetection:antidetectionInfo(),`,
    guard: `antidetection:antidetectionInfo(),`
  }
];

const extraPatches = [
  {
    name: "10/12 log fingerprint on account creation",
    find: `  const account=createAccount(slot,{enabled:false});`,
    replace: L(
      `  const account=createAccount(slot,{enabled:false});`,
      `  logAccount(account,"fingerprint",` + "`Synthetic browser identity: ${describeFingerprint(account.browserProfile)} (TLS: ${tlsImpersonationStatus().available?\"impersonated\":\"header-only fallback\"})`);"
    ),
    guard: `logAccount(account,"fingerprint",`
  },
  {
    name: "11/12 anti-detection status in startup log",
    find: '  console.log(`Dynamic account fleet: ${aiAccounts.length}/${MAX_UI_ACCOUNTS} • persistence: ${persistenceInfo().backend}`);',
    replace: L(
      '  console.log(`Dynamic account fleet: ${aiAccounts.length}/${MAX_UI_ACCOUNTS} • persistence: ${persistenceInfo().backend}`);',
      '  const ad=antidetectionInfo();',
      '  console.log(`Anti-detection: fingerprint spoofing ${ad.enabled?"ON":"OFF"} • TLS ${ad.tls.available?`impersonated (${ad.tls.binary}, ${ad.tls.impersonate})`:"fallback: headers only — install curl-impersonate for JA3 spoofing"} • human delay ${ad.humanDelayEnabled?"ON":"OFF"}`);'
    ),
    guard: `Anti-detection: fingerprint spoofing`
  },
  {
    name: "12/12 Live Anti-Bot Indicator Pill in Header",
    find: `  <div id=\"badge\" class=\"badge\">Loading…</div>\n</header>`,
    replace: L(
      `  <div id="badge" class="badge">Loading…</div>`,
      `  <div id="antiBotHudBadge" style="margin-left:12px;padding:6px 12px;border-radius:999px;background:rgba(0,240,255,0.08);border:1px solid rgba(0,240,255,0.3);font-size:10px;font-weight:900;color:#00f0ff;display:flex;align-items:center;gap:6px;box-shadow:0 0 15px rgba(0,240,255,0.15)">`,
      `    <span style="width:7px;height:7px;border-radius:50%;background:#00ff66;box-shadow:0 0 10px #00ff66"></span>`,
      `    <span>🛡️ ANTI-BOT STEALTH ACTIVE</span>`,
      `  </div>`,
      `</header>`
    ),
    guard: `antiBotHudBadge`
  }
];

if (!fs.existsSync(FILE)) {
  console.error(`Cannot find ${FILE} — run this from the folder that contains server.mjs`);
  process.exit(1);
}

let src = fs.readFileSync(FILE, "utf8");
fs.writeFileSync(BACKUP, src);

let applied = 0;
for (const p of [...patches, ...extraPatches]) {
  if (p.guard && src.includes(p.guard)) {
    console.log(`SKIP  ${p.name} (already applied)`);
    continue;
  }
  const count = src.split(p.find).length - 1;
  if (count !== 1) {
    console.log(`SKIP  ${p.name} — anchor found ${count}× (expected 1), left untouched`);
    continue;
  }
  src = src.replace(p.find, p.replace);
  applied++;
  console.log(`OK    ${p.name}`);
}

fs.writeFileSync(FILE, src);
console.log(`\nDone — ${applied}/12 patches applied.`);
