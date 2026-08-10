// apply-antidetection.mjs — Anti-Bot Stealth + Cyberpunk HUD Visual Upgrade
import fs from "node:fs";

const FILE = "server.mjs";
const BACKUP = "server.mjs.bak";
const L = (...lines) => lines.join("\n");

const patches = [
  {
    name: "1/12 import fingerprint module",
    find: `import { Pool } from "pg";`,
    replace: L(
      `import { Pool } from "pg";`,
      `import { buildBrowserProfile, impersonatedFetch, tlsImpersonationStatus, describeFingerprint, calculateHumanTypingDelay } from "./fingerprint.mjs";`
    ),
    guard: `from "./fingerprint.mjs";`
  },
  {
    name: "2/12 anti-detection config + helpers",
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
    name: "3/12 per-account browser profile (createAccount base)",
    find: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),',
    replace: '    id,sessionNamespace:String(overrides.sessionNamespace||`acct_${safeNamespaceId(id)}`),createdAt:Number(overrides.createdAt||Date.now()),updatedAt:Number(overrides.updatedAt||Date.now()),\n    browserProfile:buildBrowserProfile(id),',
    guard: `browserProfile:buildBrowserProfile(id),`
  },
  {
    name: "4/12 keep profile on restore",
    find: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);`,
    replace: `  merged.sessionNamespace=String(overrides.sessionNamespace||base.sessionNamespace);\n  merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`,
    guard: `merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);`
  },
  {
    name: "5/12 route all Kick fetches through impersonatedFetch",
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
    name: "6/12 human delay in sendKick",
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
    name: "7/12 human delay in sendKickIsolated",
    find: `    const t=await refreshAccountTokenServer(account.slot);const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    replace: `    const t=await refreshAccountTokenServer(account.slot);if(source!=="manual")await sleep(humanTypingDelay(content, account?.browserProfile));const result=await postKickChat(account,t.access_token,broadcasterUserId,content,replyToMessageId);`,
    guard: `if(source!=="manual")await sleep(humanTypingDelay(`
  },
  {
    name: "8/12 expose fingerprint in publicAccount",
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
    name: "9/12 status endpoint + startup log",
    find: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),`,
    replace: `    accountCount:aiAccounts.length,maxAccounts:MAX_UI_ACCOUNTS,dispatcher:dispatcherSettings,persistence:persistenceInfo(),isolation:accountIsolationAudit(),\n    antidetection:antidetectionInfo(),`,
    guard: `antidetection:antidetectionInfo(),`
  },
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
    name: "12/12 Cyberpunk HUD Visual Upgrade",
    find: `@media(max-width:700px){.isolationSummary{grid-template-columns:1fr}.accountQuickStats{grid-template-columns:repeat(2,minmax(0,1fr))!important}}\n\n</style>`,
    replace: L(
      `@media(max-width:700px){.isolationSummary{grid-template-columns:1fr}.accountQuickStats{grid-template-columns:repeat(2,minmax(0,1fr))!important}}`,
      ``,
      `/* CYBERPUNK HUD OVERHAUL */`,
      `:root{--bg0:#010408;--panel:rgba(8,22,38,0.88);--line:#12385c;--cyan:#00f0ff;--neon-green:#00ff66;--shadow-hud:0 20px 60px rgba(0,0,0,0.6),0 0 30px rgba(0,240,255,0.08);}`,
      `body{background:radial-gradient(circle at 15% -10%,rgba(0,240,255,0.12),transparent 40%),radial-gradient(circle at 85% 10%,rgba(138,43,226,0.1),transparent 35%),linear-gradient(180deg,var(--bg0) 0%,#020610 100%);}`,
      `header{background:var(--panel)!important;backdrop-filter:blur(16px);border:1px solid var(--line)!important;box-shadow:var(--shadow-hud);}`,
      `header h1{background:linear-gradient(135deg,#ffffff 30%,var(--cyan) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}`,
      `.card{background:var(--panel)!important;backdrop-filter:blur(14px);border:1px solid var(--line)!important;box-shadow:var(--shadow-hud);transition:border-color 0.2s ease,box-shadow 0.2s ease;}`,
      `.card:hover{border-color:rgba(0,240,255,0.4)!important;box-shadow:0 20px 70px rgba(0,0,0,0.7),0 0 30px rgba(0,240,255,0.12);}`,
      `.neoChip{background:rgba(0,240,255,0.06)!important;border:1px solid rgba(0,240,255,0.2)!important;color:var(--cyan)!important;font-family:ui-monospace,SFMono-Regular,monospace;font-size:9px!important;letter-spacing:0.08em;}`,
      `.neoChip.hot{color:var(--neon-green)!important;border-color:var(--neon-green)!important;background:rgba(0,255,102,0.08)!important;box-shadow:0 0 12px rgba(0,255,102,0.15);}`,
      `.controlTabs{background:rgba(2,8,16,0.92)!important;backdrop-filter:blur(16px);border:1px solid var(--line)!important;}`,
      `.controlTab.active{background:linear-gradient(135deg,#0066ff,var(--cyan))!important;color:#020812!important;border-color:var(--cyan)!important;box-shadow:0 0 20px rgba(0,240,255,0.35);}`,
      `.accountCard{background:linear-gradient(180deg,rgba(6,18,32,0.9),rgba(2,8,16,0.95))!important;border:1px solid var(--line)!important;}`,
      `.accountCard.connected{border-color:var(--cyan)!important;box-shadow:inset 0 0 20px rgba(0,240,255,0.08),0 0 25px rgba(0,240,255,0.1);}`,
      `.accountCard.enabled::before{background:linear-gradient(180deg,var(--cyan),var(--neon-green))!important;box-shadow:0 0 15px var(--cyan);}`,
      `button,.btn{background:linear-gradient(180deg,rgba(12,30,50,0.8),rgba(5,15,28,0.9))!important;border:1px solid var(--line)!important;}`,
      `button:hover:not(:disabled){border-color:var(--cyan)!important;box-shadow:0 0 18px rgba(0,240,255,0.25);}`,
      `.primary{background:linear-gradient(135deg,var(--cyan),#0099ff)!important;color:#020812!important;border-color:var(--cyan)!important;box-shadow:0 0 20px rgba(0,240,255,0.3)!important;}`,
      `.reply{background:#02070d!important;border:1px solid rgba(0,240,255,0.3)!important;color:#ffffff!important;text-shadow:0 0 15px rgba(0,240,255,0.2);}`,
      `.waveform.live i{background:linear-gradient(180deg,var(--cyan),var(--neon-green))!important;box-shadow:0 0 10px var(--cyan);}`,
      `\n\n</style>`
    ),
    guard: `/* CYBERPUNK HUD OVERHAUL */`
  }
];

if (!fs.existsSync(FILE)) {
  console.error(`Cannot find ${FILE} — run this from the folder that contains server.mjs`);
  process.exit(1);
}

let src = fs.readFileSync(FILE, "utf8");
fs.writeFileSync(BACKUP, src);

let applied = 0;
for (const p of patches) {
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
