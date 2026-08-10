// apply-antidetection.mjs
import fs from "node:fs";

const FILE = "server.mjs";
const BACKUP = "server.mjs.bak";
const L = (...lines) => lines.join("\n");

const patches = [
  {
    name: "1/9 import fingerprint module",
    find: `import { Pool } from "pg";`,
    replace: L(
      `import { Pool } from "pg";`,
      `import { buildBrowserProfile, impersonatedFetch, tlsImpersonationStatus, describeFingerprint, calculateHumanTypingDelay } from "./fingerprint.mjs";`
    ),
    guard: `from "./fingerprint.mjs";`
  },
  {
    name: "2/9 anti-detection config + helpers",
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
    name: "3/9 per-account browser profile (createAccount base)",
    find: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),',
    replace: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),\n    browserProfile:buildBrowserProfile(id),',
    guard: `browserProfile:buildBrowserProfile(id),`
  },
  {
    name: "4/9 keep profile on restore",
    find: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);`,
    replace: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);\n  merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`,
    guard: `merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`
  },
  {
    name: "5/9 route all Kick fetches through impersonatedFetch",
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
    name: "6/9 human delay in sendKick",
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
    name: "7/9 human delay in sendKickIsolated",
    find: `    const t=await refreshAccountTokenServer(account.slot);const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    replace: `    const t=await refreshAccountTokenServer(account.slot);if(source!=="manual")await sleep(humanTypingDelay(content, account?.browserProfile));const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    guard: `if(source!=="manual")await sleep(humanTypingDelay(`
  },
  {
    name: "8/9 expose fingerprint in publicAccount",
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
    name: "9/9 status endpoint + startup log",
    find: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),`,
    replace: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),\n    antidetection:antidetectionInfo(),`,
    guard: `antidetection:antidetectionInfo(),`
  }
];

const extraPatches = [
  {
    name: "10/11 log fingerprint on account creation",
    find: `  const account=createAccount(slot,{enabled:false});`,
    replace: L(
      `  const account=createAccount(slot,{enabled:false});`,
      `  logAccount(account,"fingerprint",` + "`Synthetic browser identity: ${describeFingerprint(account.browserProfile)} (TLS: ${tlsImpersonationStatus().available?\"impersonated\":\"header-only fallback\"})`);"
    ),
    guard: `logAccount(account,"fingerprint",`
  },
  {
    name: "11/11 anti-detection status in startup log",
    find: '  console.log(`Dynamic account fleet: ${aiAccounts.length}/${MAX_UI_ACCOUNTS} • persistence: ${persistenceInfo().backend}`);',
    replace: L(
      '  console.log(`Dynamic account fleet: ${aiAccounts.length}/${MAX_UI_ACCOUNTS} • persistence: ${persistenceInfo().backend}`);',
      '  const ad=antidetectionInfo();',
      '  console.log(`Anti-detection: fingerprint spoofing ${ad.enabled?"ON":"OFF"} • TLS ${ad.tls.available?`impersonated (${ad.tls.binary}, ${ad.tls.impersonate})`:"fallback: headers only — install curl-impersonate for JA3 spoofing"} • human delay ${ad.humanDelayEnabled?"ON":"OFF"}`);'
    ),
    guard: `Anti-detection: fingerprint spoofing`
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
console.log(`\nDone — ${applied}/11 patches applied.`);
