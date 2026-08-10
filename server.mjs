import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import nodeFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { Pool } from "pg";
import puppeteer from "puppeteer";
import { 
  buildBrowserProfile, 
  impersonatedFetch, 
  tlsImpersonationStatus, 
  describeFingerprint, 
  calculateHumanTypingDelay, 
  humanizeChatFormatting 
} from "./fingerprint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);

const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.KICK_REDIRECT_URI || "";
const CHANNEL_SLUG = process.env.KICK_CHANNEL_SLUG || "";

const BOT_NAME = process.env.BOT_NAME || "AI Co-host";
const STREAMER_NAME = process.env.STREAMER_NAME || "Streamer";
const AUTO_SEND = String(process.env.AUTO_SEND || "true").toLowerCase() === "true";

// ---- Anti-detection / fingerprint spoofing config ----
const ENABLE_FINGERPRINT_SPOOFING = String(process.env.ENABLE_FINGERPRINT_SPOOFING || "true").toLowerCase() !== "false";
const ENABLE_HUMAN_DELAY = String(process.env.ENABLE_HUMAN_DELAY || "true").toLowerCase() !== "false";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function humanTypingDelay(content = "", profile = null) {
  if (!ENABLE_HUMAN_DELAY) return 0;
  return calculateHumanTypingDelay(content, profile);
}

function antidetectionInfo() {
  return {
    enabled: ENABLE_FINGERPRINT_SPOOFING,
    humanDelayEnabled: ENABLE_HUMAN_DELAY,
    tls: tlsImpersonationStatus()
  };
}

const BOT_PERSONA_ORIGIN = process.env.BOT_PERSONA_ORIGIN || "Los Angeles, California";
const BOT_PERSONA_VIBE = process.env.BOT_PERSONA_VIBE || "laid-back, playful, confident, observant, a little sarcastic, never corny";
const BOT_PERSONA_INTERESTS = process.env.BOT_PERSONA_INTERESTS || "cars, music, internet culture, gaming, food, fashion, funny stream moments";
const BOT_PERSONA_SPEECH = process.env.BOT_PERSONA_SPEECH || "casual, short, natural, lowercase when it fits, light slang but never forced";
const BOT_PERSONA_LIKES = process.env.BOT_PERSONA_LIKES || "cars, good food, funny debates, interesting stories";
const BOT_PERSONA_DISLIKES = process.env.BOT_PERSONA_DISLIKES || "corny filler, fake hype, repeating the same joke";
const BOT_PERSONA_HUMOR = process.env.BOT_PERSONA_HUMOR || "dry, playful, quick observations and light roasting";

const DIRECTOR_MODEL_OVERRIDE = process.env.OPENAI_DIRECTOR_MODEL || "";
const WRITER_MODEL_OVERRIDE = process.env.OPENAI_WRITER_MODEL || "";
const CRITIC_MODEL_OVERRIDE = process.env.OPENAI_CRITIC_MODEL || "";
const HUMANIZER_MODEL_OVERRIDE = process.env.OPENAI_HUMANIZER_MODEL || "";

function brainModelPlan(profile={}){
  const mode=["fast","smart","max"].includes(profile.brainMode)?profile.brainMode:"smart";
  const plans={
    fast:{
      director:"gpt-5.6-terra",directorEffort:"low",
      writer:"gpt-5.6",writerEffort:"low",
      humanizer:"gpt-5.6-luna",humanizerEffort:"low",
      critic:"gpt-5.6-luna",criticEffort:"low"
    },
    smart:{
      director:"gpt-5.6",directorEffort:"high",
      writer:"gpt-5.6",writerEffort:"low",
      humanizer:"gpt-5.6",humanizerEffort:"low",
      critic:"gpt-5.6-terra",criticEffort:"low"
    },
    max:{
      director:"gpt-5.6",directorEffort:"max",
      writer:"gpt-5.6",writerEffort:"medium",
      humanizer:"gpt-5.6",humanizerEffort:"low",
      critic:"gpt-5.6",criticEffort:"medium"
    }
  };
  const p=plans[mode];
  return {
    mode,
    director:DIRECTOR_MODEL_OVERRIDE||p.director,
    directorEffort:p.directorEffort,
    writer:WRITER_MODEL_OVERRIDE||p.writer,
    writerEffort:p.writerEffort,
    humanizer:HUMANIZER_MODEL_OVERRIDE||p.humanizer,
    humanizerEffort:p.humanizerEffort,
    critic:CRITIC_MODEL_OVERRIDE||p.critic,
    criticEffort:p.criticEffort
  };
}
const FALLBACK_TRANSCRIBE_MODEL = process.env.OPENAI_FALLBACK_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const REALTIME_TRANSCRIBE_MODEL = process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-live-transcribe";
const SPEAKER_DIARIZE_MODEL = process.env.OPENAI_SPEAKER_DIARIZE_MODEL || "gpt-4o-transcribe-diarize";
const SPEAKER_CLASSIFIER_MODEL = process.env.OPENAI_SPEAKER_CLASSIFIER_MODEL || "gpt-5.6-terra";
const CONTEXT_PROBE_MODEL = process.env.OPENAI_CONTEXT_PROBE_MODEL || "gpt-5.6-terra";

const ENABLE_CRITIC = String(process.env.ENABLE_CRITIC || "true").toLowerCase() === "true";

const MIN_NORMAL_INTERVAL_MS = Number(process.env.MIN_NORMAL_INTERVAL_MS || 18000);
const MIN_CONVERSATION_INTERVAL_MS = Number(process.env.MIN_CONVERSATION_INTERVAL_MS || 9000);
const PROACTIVE_MIN_MS = Number(process.env.PROACTIVE_MIN_MS || 120000);
const PROACTIVE_MAX_MS = Number(process.env.PROACTIVE_MAX_MS || 300000);

const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

const ACCOUNT_RUNTIME_ROOT = path.resolve(process.env.ACCOUNT_RUNTIME_ROOT || path.join(os.tmpdir(),"juniors-ai-chat-runtimes"));
const ACCOUNT_DECISION_QUEUE_LIMIT = Math.max(2,Math.min(200,Number(process.env.ACCOUNT_DECISION_QUEUE_LIMIT||30)));
const ACCOUNT_SEND_QUEUE_LIMIT = Math.max(1,Math.min(100,Number(process.env.ACCOUNT_SEND_QUEUE_LIMIT||12)));
const ACCOUNT_EVENT_QUEUE_LIMIT = Math.max(10,Math.min(1000,Number(process.env.ACCOUNT_EVENT_QUEUE_LIMIT||180)));
const ACCOUNT_DEAD_LETTER_LIMIT = Math.max(10,Math.min(1000,Number(process.env.ACCOUNT_DEAD_LETTER_LIMIT||120)));
const ACCOUNT_EVENT_JOURNAL_LIMIT = Math.max(20,Math.min(2000,Number(process.env.ACCOUNT_EVENT_JOURNAL_LIMIT||300)));
const ACCOUNT_RUNTIME_FAILURE_LIMIT = Math.max(3,Math.min(50,Number(process.env.ACCOUNT_RUNTIME_FAILURE_LIMIT||10)));
const ACCOUNT_RUNTIME_FAILURE_WINDOW_MS = Math.max(30000,Math.min(10*60*1000,Number(process.env.ACCOUNT_RUNTIME_FAILURE_WINDOW_MS||120000)));
const ACCOUNT_WATCHDOG_MS = Math.max(5000,Math.min(60000,Number(process.env.ACCOUNT_WATCHDOG_MS||15000)));
const BOOT_ISOLATION_SECRET = crypto.randomBytes(32);

const ACCOUNT_BROWSER_ENABLED = String(process.env.ACCOUNT_BROWSER_ENABLED || "false").toLowerCase() === "true";
const ACCOUNT_BROWSER_HEADLESS = String(process.env.ACCOUNT_BROWSER_HEADLESS || "true").toLowerCase() !== "false";
const ACCOUNT_BROWSER_ROOT = path.resolve(process.env.ACCOUNT_BROWSER_ROOT || path.join(ACCOUNT_RUNTIME_ROOT,"browser-profiles"));
const ACCOUNT_BROWSER_START_TIMEOUT_MS = Math.max(10000,Math.min(120000,Number(process.env.ACCOUNT_BROWSER_START_TIMEOUT_MS||45000)));
const accountBrowserRuntimes = new Map();

if (!SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JUNIORS AI CHAT v10.5 HUD</title>
<style>
:root {
  --bg0: #010408;
  --bg1: #040a14;
  --bg2: #081222;
  --panel: rgba(8, 22, 38, 0.85);
  --line: #12385c;
  --cyan: #00f0ff;
  --neon-green: #00ff66;
  --blue: #0066ff;
  --purple: #8a2be2;
  --text: #f0f8ff;
  --muted: #64829f;
  --danger: #ff2a6d;
  --warning: #ffb703;
  --shadow-hud: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(0, 240, 255, 0.08);
}

body {
  margin: 0;
  color: var(--text);
  font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: 
    radial-gradient(circle at 15% -10%, rgba(0, 240, 255, 0.12), transparent 40%),
    radial-gradient(circle at 85% 10%, rgba(138, 43, 226, 0.1), transparent 35%),
    linear-gradient(180deg, var(--bg0) 0%, #020610 100%);
  min-height: 100vh;
}

body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  background-image: 
    linear-gradient(rgba(0, 240, 255, 0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 240, 255, 0.02) 1px, transparent 1px);
  background-size: 32px 32px;
}

main {
  width: min(1840px, calc(100vw - 26px));
  margin: 16px auto 60px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

header {
  grid-column: 1/-1;
  position: relative;
  background: var(--panel);
  backdrop-filter: blur(16px);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: var(--shadow-hud);
  padding: 22px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

header::before {
  content: "";
  position: absolute;
  top: -1px; left: 30px; right: 30px; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cyan), transparent);
}

h1 {
  margin: 4px 0;
  font-size: clamp(28px, 4vw, 42px);
  font-weight: 900;
  letter-spacing: -0.04em;
  background: linear-gradient(135deg, #ffffff 30%, var(--cyan) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

h2 { font-size: 18px; margin: 0 0 12px; }
p { color: var(--muted); line-height: 1.5; }
.eyebrow { font-size: 10px; letter-spacing: 0.16em; color: var(--cyan); font-weight: 800; text-transform: uppercase; }

.card {
  position: relative;
  background: var(--panel);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 18px;
  box-shadow: var(--shadow-hud);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.card:hover {
  border-color: rgba(0, 240, 255, 0.4);
  box-shadow: 0 20px 70px rgba(0, 0, 0, 0.7), 0 0 30px rgba(0, 240, 255, 0.12);
}

.row { display: flex; gap: 9px; flex-wrap: wrap; margin: 10px 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

button, .btn {
  background: linear-gradient(180deg, rgba(12, 30, 50, 0.8), rgba(5, 15, 28, 0.9));
  border: 1px solid var(--line);
  color: var(--text);
  font-weight: 750;
  padding: 10px 13px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

button:hover:not(:disabled) {
  border-color: var(--cyan);
  box-shadow: 0 0 18px rgba(0, 240, 255, 0.25);
  transform: translateY(-1px);
}

button:disabled { opacity: 0.45; cursor: not-allowed; }

.primary {
  background: linear-gradient(135deg, var(--cyan), #0099ff) !important;
  color: #020812 !important;
  border-color: var(--cyan) !important;
  font-weight: 900 !important;
  box-shadow: 0 0 20px rgba(0, 240, 255, 0.3) !important;
}

.danger {
  color: #ffdbe4;
  border-color: #5c2336;
  background: #180a10;
}

input, textarea, select {
  width: 100%;
  padding: 11px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: #030912;
  color: var(--text);
  margin: 7px 0;
}

input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.12);
}

.status { color: var(--muted); min-height: 20px; word-break: break-word; font-size: 11px; }
.big { color: var(--text); font-size: 16px; }
.label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 800; margin-bottom: 5px; }

.reply {
  font-size: 22px;
  background: #02070d;
  border: 1px solid rgba(0, 240, 255, 0.3);
  border-radius: 12px;
  padding: 16px;
  min-height: 60px;
  color: #ffffff;
  text-shadow: 0 0 15px rgba(0, 240, 255, 0.2);
}

.brain, pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #02070d;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  color: #a0ecff;
  white-space: pre-wrap;
  word-break: break-word;
}

.neoChip {
  padding: 5px 9px;
  border: 1px solid rgba(0, 240, 255, 0.2);
  border-radius: 999px;
  background: rgba(0, 240, 255, 0.06);
  color: var(--cyan);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.neoChip.hot {
  color: var(--neon-green);
  border-color: var(--neon-green);
  background: rgba(0, 255, 102, 0.08);
  box-shadow: 0 0 12px rgba(0, 255, 102, 0.15);
}

.controlTabs {
  grid-column: 1/-1;
  position: sticky;
  top: 8px;
  z-index: 80;
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: rgba(2, 8, 16, 0.92);
  backdrop-filter: blur(16px);
}

.controlTab {
  appearance: none;
  padding: 9px 15px;
  border-radius: 10px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 850;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  transition: all 0.15s ease;
}

.controlTab.active {
  background: linear-gradient(135deg, var(--blue), var(--cyan)) !important;
  color: #020812 !important;
  border-color: var(--cyan) !important;
  box-shadow: 0 0 20px rgba(0, 240, 255, 0.35);
}

.accountGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 13px; margin-top: 14px; }

.accountCard {
  position: relative;
  background: linear-gradient(180deg, rgba(6, 18, 32, 0.9), rgba(2, 8, 16, 0.95));
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 15px;
  overflow: hidden;
}

.accountCard.connected {
  border-color: var(--cyan);
  box-shadow: inset 0 0 20px rgba(0, 240, 255, 0.08), 0 0 25px rgba(0, 240, 255, 0.1);
}

.accountCard.enabled::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0; width: 3px;
  background: linear-gradient(180deg, var(--cyan), var(--neon-green));
  box-shadow: 0 0 15px var(--cyan);
}

.fpBadge {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(0, 240, 255, 0.05);
  border: 1px solid rgba(0, 240, 255, 0.2);
  color: #a0ecff;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tabHidden { display: none !important; }
</style>
</head>
<body>
<main>
<header>
  <div>
    <div class="eyebrow">JUNIORS AI CHAT • ADVANCED STEALTH HUD V10.5</div>
    <h1>JUNIORS AI CHAT</h1>
    <p>Multi-account AI co-host system • shared raw capture • zero-trust anti-bot stealth & typing physics</p>
    <div class="neoStrip">
      <span class="neoChip hot">FINGERPRINT SPOOFING ON</span>
      <span class="neoChip">HUMAN TYPING PHYSICS</span>
      <span class="neoChip">DYNAMIC 1–100 ACCOUNTS</span>
      <span class="neoChip">SOCKS5 ROUTING</span>
      <span class="neoChip">LIVE CHAT</span>
    </div>
  </div>
  <div id="badge" class="badge">Loading…</div>
</header>

<nav class="controlTabs" id="controlTabs">
  <button class="controlTab active" data-control-tab="dashboard">Overview</button>
  <button class="controlTab" data-control-tab="accounts">AI Accounts</button>
  <button class="controlTab" data-control-tab="brain">AI Brain</button>
  <button class="controlTab" data-control-tab="stream">Stream + Chat</button>
  <button class="controlTab" data-control-tab="manual">Manual Send</button>
  <button class="controlTab" data-control-tab="logs">Diagnostics</button>
</nav>

<section class="card" id="ai-accounts">
  <h2>AI Account Fleet & Anti-Bot Status</h2>
  <div id="accountsGrid" class="accountGrid"></div>
</section>

<section class="card" id="master-control">
  <h2>System Control</h2>
  <div id="masterState" class="masterState running">AI RUNNING</div>
  <div class="row">
    <button id="pauseAll" class="danger">Pause All AI</button>
    <button id="resumeAll" class="primary">Resume All AI</button>
  </div>
  <div id="masterStatus" class="status">Checking…</div>
</section>

<section class="card" id="latest-reply">
  <h2>Latest AI Transmission</h2>
  <div id="reply" class="reply">(waiting)</div>
  <div id="replyStatus" class="status"></div>
</section>

<section class="card" id="system-log">
  <h2>System Log</h2>
  <pre id="log"></pre>
</section>
</main>

<script>
const $ = id => document.getElementById(id);

async function jf(url, options={}){
  const r = await fetch(url, options);
  return r.json();
}

function renderAccounts(accounts=[]){
  const grid = $("accountsGrid");
  if(!grid) return;
  grid.innerHTML = accounts.map(srv => {
    const fp = srv.fingerprint || {};
    const shortFp = fp.short || "Chrome 131 • Win32";
    const tlsStatus = fp.tls?.available ? "TLS Impersonated" : "Header Spoofed";
    return \`<div class="accountCard \${srv.connected ? 'connected' : ''} \${srv.enabled ? 'enabled' : ''}">
      <div style="font-weight:900;font-size:16px;">Slot \${srv.slot} • @\${srv.username || 'Unconnected'}</div>
      <div class="status" style="margin:4px 0;">Role: \${srv.role || 'main'} • Sent: \${srv.messagesSent || 0}</div>
      <div class="fpBadge">
        <span>🛡️ \${shortFp}</span>
        <span style="color:var(--neon-green)">\${tlsStatus}</span>
      </div>
    </div>\`;
  }).join('');
}

async function loadStatus(){
  try {
    const d = await jf('/api/accounts');
    if(d.accounts) renderAccounts(d.accounts);
  } catch(e){}
}

loadStatus();
setInterval(loadStatus, 5000);
</script>
</body>
</html>`;

// ---------------- Dashboard password protection ----------------
app.use((req,res,next)=>{
  if(req.path==="/auth/kick/callback" || req.path==="/health" || req.path==="/webhooks/kick") return next();
  if(!DASHBOARD_PASSWORD) return next();

  const auth=req.headers.authorization||"";
  if(auth.startsWith("Basic ")){
    try{
      const decoded=Buffer.from(auth.slice(6),"base64").toString("utf8");
      const idx=decoded.indexOf(":");
      const user=idx>=0?decoded.slice(0,idx):"";
      const pass=idx>=0?decoded.slice(idx+1):"";
      if(user==="backendboys" && pass===DASHBOARD_PASSWORD) return next();
    }catch{}
  }

  res.setHeader("WWW-Authenticate",'Basic realm="Backendboys AI"');
  res.status(401).send("Login required.");
});

// ---------------- Encrypted cookies ----------------
function keyBytes(){
  return crypto.createHash("sha256")
    .update(SESSION_SECRET || "change-me")
    .digest();
}

function seal(obj){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",keyBytes(),iv);
  const encrypted=Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj),"utf8")),
    cipher.final()
  ]);
  const tag=cipher.getAuthTag();
  return [iv,tag,encrypted].map(b=>b.toString("base64url")).join(".");
}

function unseal(value){
  try{
    const [iv,tag,data]=String(value||"").split(".");
    if(!iv||!tag||!data) return null;
    const decipher=crypto.createDecipheriv(
      "aes-256-gcm",
      keyBytes(),
      Buffer.from(iv,"base64url")
    );
    decipher.setAuthTag(Buffer.from(tag,"base64url"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(data,"base64url")),
      decipher.final()
    ]).toString("utf8"));
  }catch{return null}
}

function accountEnvelopeKey(accountId){
  const root=SESSION_SECRET?Buffer.from(SESSION_SECRET,"utf8"):BOOT_ISOLATION_SECRET;
  return crypto.createHmac("sha256",root).update(`juniors-account-envelope:v10.3:${String(accountId||"")}`).digest();
}
function sealForAccount(accountId,obj){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",accountEnvelopeKey(accountId),iv);
  cipher.setAAD(Buffer.from(`account:${String(accountId||"")}:v10.3`));
  const encrypted=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj),"utf8")),cipher.final()]);
  const tag=cipher.getAuthTag();
  return [iv,tag,encrypted].map(b=>b.toString("base64url")).join(".");
}
function unsealForAccount(accountId,value){
  try{
    const [iv,tag,data]=String(value||"").split(".");if(!iv||!tag||!data)return null;
    const decipher=crypto.createDecipheriv("aes-256-gcm",accountEnvelopeKey(accountId),Buffer.from(iv,"base64url"));
    decipher.setAAD(Buffer.from(`account:${String(accountId||"")}:v10.3`));decipher.setAuthTag(Buffer.from(tag,"base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8"));
  }catch{return null;}
}
function accountEnvelopeDigest(accountId,value){return crypto.createHash("sha256").update(`${String(accountId||"")}:${String(value||"")}`).digest("hex").slice(0,20);}

function cookies(req){
  const out={};
  for(const part of String(req.headers.cookie||"").split(";")){
    const idx=part.indexOf("=");
    if(idx<0) continue;
    const k=part.slice(0,idx).trim();
    const v=part.slice(idx+1).trim();
    try{out[k]=decodeURIComponent(v)}catch{out[k]=v}
  }
  return out;
}

function appendCookie(res,value){
  const cur=res.getHeader("Set-Cookie");
  if(!cur) res.setHeader("Set-Cookie",[value]);
  else if(Array.isArray(cur)) res.setHeader("Set-Cookie",[...cur,value]);
  else res.setHeader("Set-Cookie",[cur,value]);
}

function setEncryptedCookie(res,name,obj,maxAge){
  appendCookie(
    res,
    `${name}=${encodeURIComponent(seal(obj))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function getEncryptedCookie(req,name){
  return unseal(cookies(req)[name]);
}

function clearCookie(res,name){
  appendCookie(
    res,
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

// ---------------- Multi-AI account manager ----------------
const MAX_UI_ACCOUNTS=Math.max(1,Math.min(500,Number(process.env.MAX_UI_ACCOUNTS||100)));
const DEFAULT_ACCOUNT_COUNT=Math.max(1,Math.min(MAX_UI_ACCOUNTS,Number(process.env.DEFAULT_ACCOUNT_COUNT||5)));
const PERSISTENCE_DIR=String(process.env.PERSISTENCE_DIR||process.env.RENDER_DISK_MOUNT_PATH||"").trim();
const ACCOUNT_STORE_PATH=String(process.env.ACCOUNT_STORE_PATH||(PERSISTENCE_DIR?path.join(PERSISTENCE_DIR,"juniors-ai-chat-state.enc"):"")).trim();
const DATABASE_URL=String(process.env.DATABASE_URL||"").trim();
const DB_STATE_ID="primary";
if((DATABASE_URL||ACCOUNT_STORE_PATH)&&!SESSION_SECRET){
  throw new Error("SESSION_SECRET is required when durable persistence is enabled.");
}
const dbPool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:10000}):null;
let persistenceDbReady=false;
let persistenceLastSaveAt=0;
let persistenceLastError="";
let pendingRuntimeProfile=null;
let persistedSharedMemory={};
let persistedBroadcasterId=String(process.env.KICK_BROADCASTER_USER_ID||"");

function accountPersonalityPreset(slot){
  const presets=[
    {name:"The Captain",vibe:"laid-back, confident, grounded",speech:"short casual sentences",humor:"dry observations",interests:"cars, stream moments",energy:"medium",roast:"light",questions:"rare"},
    {name:"The Analyst",vibe:"observant, sharp, detail-focused",speech:"concise and specific",humor:"clever dry humor",interests:"strategy, decisions, game sense",energy:"low",roast:"none",questions:"rare"}
  ];
  const n=Math.max(1,Number(slot)||1),base={...presets[(n-1)%presets.length]};
  return base;
}

function defaultAccountSettings(slot){
  return {
    slot:Number(slot),enabled:Number(slot)===1,username:"",role:"main",personaNote:"balanced co-host",
    personality:accountPersonalityPreset(slot),cooldownSeconds:15,
    proxyEnabled:false,proxyHost:"",proxyPort:"",proxyVerifiedAt:0,proxyVerifiedIp:"",proxyVerifiedFingerprint:"",
    credentialUsername:"",credentialPassword:""
  };
}

function createAccount(slot,overrides={}){
  const id=String(overrides.id||crypto.randomUUID());
  const base={
    ...defaultAccountSettings(slot),
    id,
    sessionNamespace:`acct_${safeNamespaceId(id)}`,
    createdAt:Number(overrides.createdAt||Date.now()),
    updatedAt:Number(overrides.updatedAt||Date.now()),
    token:null,authorizedUserId:"",authorizedUsername:"",lastSentAt:0,messagesSent:0,lastReply:"",replyHistory:[],logs:[],
    browserProfile:buildBrowserProfile(id)
  };
  const merged={...base,...overrides,id,slot:Number(slot)};
  merged.browserProfile = merged.browserProfile || buildBrowserProfile(merged.id);
  return merged;
}

function safeNamespaceId(value){return String(value||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80)}

const aiAccounts=[];
for(let slot=1;slot<=DEFAULT_ACCOUNT_COUNT;slot++)aiAccounts.push(createAccount(slot));

let dispatcherSettings={mode:"natural",soloSlot:1,spacingSeconds:2,multiCount:3};

function accountBySlot(slot){return aiAccounts.find(a=>a.slot===Number(slot))||null}
function enabledConnectedAccounts(){return aiAccounts.filter(a=>a.enabled&&Boolean(a.token?.access_token))}

function proxyUrlForAccount(account){
  if(!account?.proxyEnabled)return "";
  let raw=String(account.proxyHost||"").trim();
  if(!raw)return "";
  if(!/^(socks5h?):\/\//i.test(raw)) raw=`socks5://${raw}`;
  return raw;
}

function proxyAgentForAccount(account){
  const proxyUrl=proxyUrlForAccount(account);
  if(!proxyUrl)return null;
  return new SocksProxyAgent(proxyUrl);
}

async function fetchForAccount(account,url,options={}){
  if(!account) return fetch(url,options);
  const agent=proxyAgentForAccount(account);
  try {
    return await impersonatedFetch(account,url,{...options,agent},{
      proxyUrl:proxyUrlForAccount(account),
      profile:account.browserProfile
    });
  } catch(e) {
    throw e;
  }
}

function formatOutgoingChat(content){
  let s=String(content||"")
    .replace(/-{3,}/g," ")
    .replace(/[\u2010-\u2015\u2212]/g," ")
    .replace(/\s+/g," ")
    .trim();

  // Apply human chat formatting (remove stiff trailing periods, 75% lowercase first letter)
  s = humanizeChatFormatting(s);
  return s;
}

async function postKickChat(account,accessToken,broadcasterUserId,content,replyToMessageId=""){
  const payload={broadcaster_user_id:Number(broadcasterUserId),content:formatOutgoingChat(content).slice(0,500),type:"user"};
  if(replyToMessageId) payload.reply_to_message_id=String(replyToMessageId);
  const r=await fetchForAccount(account,"https://api.kick.com/public/v1/chat",{method:"POST",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`Kick send failed (${r.status}): ${JSON.stringify(data)}`); return data;
}

async function sendKick(req,res,content,replyToMessageId="",slot=null,source="ai"){
  let account=slot?accountBySlot(slot):enabledConnectedAccounts()[0];
  if(!account?.token?.access_token) throw new Error("No authorized AI account is available.");
  
  // Calculate dynamic WPM human delay based on message length
  if(source!=="manual" && source!=="test") await sleep(humanTypingDelay(content, account?.browserProfile));

  const result=await postKickChat(account,account.token.access_token,process.env.KICK_BROADCASTER_USER_ID||"",content,replyToMessageId);
  account.messagesSent = (account.messagesSent || 0) + 1;
  account.lastSentAt = Date.now();
  return {result,account};
}

async function sendKickIsolated(account,broadcasterUserId,content,replyToMessageId="",source="isolated-ai"){
  if(!account?.enabled||!account.token?.access_token)throw new Error(`Account ${account?.slot||"?"} is not ready`);
  
  // Calculate dynamic WPM human delay based on message length
  if(source!=="manual") await sleep(humanTypingDelay(content, account?.browserProfile));

  const result=await postKickChat(account,account.token.access_token,broadcasterUserId,content,replyToMessageId);
  account.messagesSent = (account.messagesSent || 0) + 1;
  account.lastSentAt = Date.now();
  return {result,account};
}

function publicAccount(account){
  return {
    id:account.id,
    slot:account.slot,
    connected:Boolean(account.token?.access_token),
    enabled:Boolean(account.enabled),
    username:account.authorizedUsername||account.username||"",
    role:account.role,
    messagesSent:account.messagesSent||0,
    fingerprint: account.browserProfile ? {
      short: describeFingerprint(account.browserProfile),
      userAgent: account.browserProfile.userAgent,
      platform: account.browserProfile.platform,
      chromeMajor: account.browserProfile.chromeMajor,
      typingWpm: account.browserProfile.typingWpm,
      tls: tlsImpersonationStatus()
    } : null
  };
}

app.get("/health",(_req,res)=>res.json({ok:true,version:"10.5.0",antidetection:antidetectionInfo()}));
app.get("/",(_req,res)=>res.type("html").send(DASHBOARD_HTML));

app.get("/api/accounts",(_req,res)=>{
  res.json({
    ok:true,
    accounts:aiAccounts.map(publicAccount)
  });
});

app.get("/api/status",(_req,res)=>{
  res.json({
    ok:true,
    autoSend:AUTO_SEND,
    accountCount:aiAccounts.length,
    antidetection:antidetectionInfo()
  });
});

const httpServer=app.listen(PORT,"0.0.0.0",()=>{
  console.log(`JUNIORS AI CHAT v10.5 running on port ${PORT}`);
  const ad=antidetectionInfo();
  console.log(`Anti-detection: fingerprint spoofing ${ad.enabled?"ON":"OFF"} • TLS ${ad.tls.available?`impersonated (${ad.tls.binary}, ${ad.tls.impersonate})`:"fallback: headers only"} • human delay ${ad.humanDelayEnabled?"ON":"OFF"}`);
});
