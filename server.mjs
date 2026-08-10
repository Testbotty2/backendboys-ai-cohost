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

// Fictional co-host persona. These are character traits, not claims of human
// lived experience or physical residence.
const BOT_PERSONA_ORIGIN =
  process.env.BOT_PERSONA_ORIGIN || "Los Angeles, California";
const BOT_PERSONA_VIBE =
  process.env.BOT_PERSONA_VIBE ||
  "laid-back, playful, confident, observant, a little sarcastic, never corny";
const BOT_PERSONA_INTERESTS =
  process.env.BOT_PERSONA_INTERESTS ||
  "cars, music, internet culture, gaming, food, fashion, funny stream moments";
const BOT_PERSONA_SPEECH =
  process.env.BOT_PERSONA_SPEECH ||
  "casual, short, natural, lowercase when it fits, light slang but never forced";
const BOT_PERSONA_LIKES =
  process.env.BOT_PERSONA_LIKES ||
  "cars, good food, funny debates, interesting stories";
const BOT_PERSONA_DISLIKES =
  process.env.BOT_PERSONA_DISLIKES ||
  "corny filler, fake hype, repeating the same joke";
const BOT_PERSONA_HUMOR =
  process.env.BOT_PERSONA_HUMOR ||
  "dry, playful, quick observations and light roasting";

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
const FALLBACK_TRANSCRIBE_MODEL =
  process.env.OPENAI_FALLBACK_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const REALTIME_TRANSCRIBE_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-live-transcribe";
const SPEAKER_DIARIZE_MODEL =
  process.env.OPENAI_SPEAKER_DIARIZE_MODEL || "gpt-4o-transcribe-diarize";
const SPEAKER_CLASSIFIER_MODEL =
  process.env.OPENAI_SPEAKER_CLASSIFIER_MODEL || "gpt-5.6-terra";
const CONTEXT_PROBE_MODEL =
  process.env.OPENAI_CONTEXT_PROBE_MODEL || "gpt-5.6-terra";

const ENABLE_CRITIC =
  String(process.env.ENABLE_CRITIC || "true").toLowerCase() === "true";

const MIN_NORMAL_INTERVAL_MS =
  Number(process.env.MIN_NORMAL_INTERVAL_MS || 18000);
const MIN_CONVERSATION_INTERVAL_MS =
  Number(process.env.MIN_CONVERSATION_INTERVAL_MS || 9000);
const PROACTIVE_MIN_MS =
  Number(process.env.PROACTIVE_MIN_MS || 120000);
const PROACTIVE_MAX_MS =
  Number(process.env.PROACTIVE_MAX_MS || 300000);

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

const DASHBOARD_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>JUNIORS AI CHAT v10.4</title>\n<style>\n:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:#09090b;color:#f4f4f5}\nmain{max-width:980px;margin:28px auto 80px;padding:0 16px}\nheader{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:18px}\nh1{margin:4px 0;font-size:clamp(28px,5vw,44px)}\nh2{font-size:18px;margin:0 0 12px}\np{color:#a1a1aa;line-height:1.5}\n.eyebrow{font-size:11px;letter-spacing:.14em;color:#71717a}\n.card{background:#131316;border:1px solid #29292e;border-radius:16px;padding:18px;margin:13px 0}\n.row{display:flex;gap:9px;flex-wrap:wrap;margin:10px 0}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}\nbutton,.btn{border:1px solid #3f3f46;background:#232327;color:#fff;padding:10px 13px;border-radius:99px;cursor:pointer;text-decoration:none;font-weight:650}\nbutton:disabled{opacity:.45;cursor:not-allowed}\n.primary{background:#fafafa;color:#09090b;border-color:#fafafa}\n.danger{border-color:#7f1d1d}\ninput,textarea,select{width:100%;padding:11px;border-radius:9px;border:1px solid #3f3f46;background:#0c0c0f;color:#fff;margin:7px 0}textarea{min-height:90px;resize:vertical}input[type=\"range\"]{padding:0}\n.status{color:#a1a1aa;min-height:20px;word-break:break-word}\n.big{color:#f4f4f5;font-size:16px}\n.label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#71717a;margin-bottom:5px}\n.reply{font-size:20px;background:#0c0c0f;border:1px solid #27272a;border-radius:12px;padding:14px;min-height:55px}\n.brain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#0c0c0f;border-radius:10px;padding:12px;white-space:pre-wrap;min-height:74px}\nvideo{width:100%;max-height:360px;background:#000;border-radius:12px;margin-top:12px}\npre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:#0c0c0f;border-radius:10px;padding:12px;color:#a7f3d0;font-size:12px}\n.badge{padding:7px 10px;border:1px solid #3f3f46;border-radius:999px;font-size:12px;white-space:nowrap}.stat{background:#0c0c0f;border:1px solid #27272a;border-radius:12px;padding:12px}.stat b{display:block;font-size:23px}.switchline{display:flex;align-items:center;gap:8px}.switchline input{width:auto}.rangeLine{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px}\nstrong{color:#fff}\nbody{\n  background:\n    radial-gradient(circle at 20% -10%,rgba(83,255,77,.10),transparent 34%),\n    radial-gradient(circle at 90% 10%,rgba(83,255,77,.05),transparent 30%),\n    #070908\n}\nmain{\n  width:min(1760px,calc(100vw - 24px));max-width:none;margin:16px auto 60px;padding:0;\n  display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;align-items:start\n}\nheader{\n  grid-column:1/-1;\n  padding:20px;\n  background:linear-gradient(135deg,rgba(19,25,20,.94),rgba(9,11,10,.94));\n  border:1px solid #203024;border-radius:20px;\n  box-shadow:0 18px 60px rgba(0,0,0,.28)\n}\n.card{background:linear-gradient(180deg,#111512,#0d100e);border-color:#222d24;margin:0;min-width:0}\n.primary{background:#53fc18;color:#061004;border-color:#53fc18}\n.accountGrid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:14px}\n.accountCard{\n  position:relative;background:#090c0a;border:1px solid #273029;border-radius:16px;\n  padding:14px;overflow:hidden;min-width:0\n}\n.accountCard.connected{border-color:#376c3c;box-shadow:inset 0 0 0 1px rgba(83,252,24,.05)}\n.accountCard.enabled:before{\n  content:\"\";position:absolute;left:0;top:0;bottom:0;width:3px;background:#53fc18\n}\n.accountTop{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.accountName{font-weight:800;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dot{width:9px;height:9px;border-radius:50%;background:#3f3f46;display:inline-block;margin-right:6px}\n.dot.on{background:#53fc18;box-shadow:0 0 14px rgba(83,252,24,.7)}\n.slot{font:700 10px ui-monospace,SFMono-Regular,monospace;color:#71717a}\n.accountMeta{color:#8f9b91;font-size:11px;margin:7px 0 10px;min-height:30px}\n.miniRow{display:flex;gap:6px;flex-wrap:wrap}\n.miniBtn{padding:7px 8px;font-size:11px}\n.dispatcherBox{\n  display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:13px;\n  border-radius:14px;background:#090c0a;border:1px solid #263129;margin-top:12px\n}\n.accountEditor{margin-top:10px;padding-top:10px;border-top:1px solid #1c251e}\n.accountEditor input,.accountEditor select{font-size:12px;padding:8px}\n.accountEditor .label{font-size:9px}\n.networkBox{\n  margin-top:12px;border:1px solid #263129;border-radius:12px;background:#070a08;overflow:hidden\n}\n.networkBox summary{\n  cursor:pointer;padding:10px 11px;font-size:11px;font-weight:800;color:#c8d3ca;\n  list-style:none;display:flex;justify-content:space-between;align-items:center\n}\n.networkBox summary::-webkit-details-marker{display:none}\n.networkBox summary:after{content:\"+\";font-size:16px;color:#53fc18}\n.networkBox[open] summary:after{content:\"−\"}\n.networkInner{padding:0 10px 11px;border-top:1px solid #1c251e}\n.networkGrid{display:grid;grid-template-columns:1fr 90px;gap:7px}\n.networkStatus{font-size:10px;color:#89948b;margin-top:7px;min-height:14px}\n.networkHint{font-size:9px;color:#687169;line-height:1.35;margin-top:7px}\n.credentialBox{\n  margin-top:10px;padding:10px;border:1px solid #263129;border-radius:12px;background:#080b09\n}\n.credentialBox.locked{border-style:dashed;opacity:.72}\n.credentialTitle{font-size:11px;font-weight:800;color:#c8d3ca;margin-bottom:7px}\n.credentialStatus{font-size:10px;color:#89948b;margin-top:6px;min-height:14px}\n.credentialRow{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:end}\n.passwordToggle{padding:8px 10px;font-size:10px;min-width:60px}\n.readyBadge{\n  display:inline-flex;align-items:center;gap:6px;font-size:9px;font-weight:800;\n  padding:5px 7px;border-radius:999px;border:1px solid #315d35;color:#91df97;background:#0b160d\n}\n.lockBadge{\n  display:inline-flex;align-items:center;gap:6px;font-size:9px;font-weight:800;\n  padding:5px 7px;border-radius:999px;border:1px solid #3a3a3a;color:#8c8c8c;background:#111\n}\n.accountConnect.lockedConnect{opacity:.45;cursor:not-allowed;border-color:#303530;color:#838883}\n.setupOrder{\n  margin:8px 0 0;padding:8px 10px;border:1px solid #253126;border-radius:10px;\n  font-size:10px;color:#96a299;background:#090c0a;line-height:1.45\n}\n.heroPill{display:inline-flex;gap:7px;align-items:center;padding:7px 10px;border:1px solid #2b3a2d;border-radius:999px;color:#b9c5bb;font-size:11px}\n.contextLive{color:#53fc18;font-weight:750}\n\n.connectModal{\n  position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;\n  padding:18px;background:rgba(0,0,0,.78);backdrop-filter:blur(10px)\n}\n.connectModal.show{display:flex}\n.connectPanel{\n  width:min(520px,100%);background:linear-gradient(180deg,#121713,#090c0a);\n  border:1px solid #2d3c30;border-radius:20px;padding:20px;\n  box-shadow:0 30px 100px rgba(0,0,0,.55)\n}\n.connectIcon{\n  width:48px;height:48px;border-radius:15px;background:#53fc18;color:#061004;\n  display:grid;place-items:center;font-size:24px;font-weight:900;margin-bottom:14px\n}\n.connectTitle{font-size:22px;font-weight:900;margin:0 0 6px}\n.connectText{font-size:12px;color:#a5b0a7;line-height:1.55}\n.connectSteps{\n  margin:14px 0;padding:12px;border-radius:13px;border:1px solid #213025;background:#090c0a\n}\n.connectStep{display:flex;gap:9px;align-items:flex-start;padding:5px 0;font-size:11px;color:#bac4bc}\n.connectNum{\n  width:19px;height:19px;flex:0 0 19px;border-radius:50%;display:grid;place-items:center;\n  background:#18201a;color:#53fc18;font-size:9px;font-weight:900\n}\n.connectActions{display:flex;gap:8px;margin-top:14px}\n.connectActions button{flex:1}\n.connectBanner{\n  display:none;margin-top:10px;padding:10px 12px;border-radius:12px;\n  border:1px solid #28582e;background:rgba(83,252,24,.055);font-size:11px;color:#bcd4bf\n}\n\n.connectBanner.show{display:block}\n#ai-accounts{grid-column:1/-1}\n#master-control,#live-context,#manual-messages{grid-column:span 4}\n#stream-channel,#kick-test,#session-stats{grid-column:span 4}\n#personality-panel,#stream-watch{grid-column:span 8}\n#live-chat,#latest-reply{grid-column:span 4}\n#memory-manager,#why-panel,#account-activity,#system-log{grid-column:span 6}\n.quickPanel{min-height:250px}\n.panelHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}\n.panelSub{font-size:11px;color:#89948b;line-height:1.45}\n.readiness{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 10px}\n.checkPill{font-size:8px;font-weight:900;letter-spacing:.04em;padding:4px 6px;border-radius:999px;border:1px solid #323a33;color:#777f78;background:#0b0d0b}\n.checkPill.ok{border-color:#315d35;color:#82e28a;background:#0a160c}\n.checkPill.warn{border-color:#66561f;color:#e3c963;background:#171407}\n.checkPill.bad{border-color:#663131;color:#e68e8e;background:#170b0b}\n.contextHero{font-size:24px;font-weight:900;color:#53fc18;line-height:1.1;word-break:break-word;margin:8px 0}\n.contextMeta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:12px}\n.contextMeta .stat b{font-size:16px}\n.masterButtons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}\n.masterState{font-size:26px;font-weight:900;line-height:1.1;margin:10px 0}\n.masterState.running{color:#53fc18}.masterState.paused{color:#f59e0b}\n.manualTextarea{min-height:110px;font-size:15px}\n.charLine{display:flex;justify-content:space-between;font-size:10px;color:#79817a;margin-top:-2px}\n.manualBadgeBox{\n  margin:9px 0 10px;padding:10px;border:1px solid #29362b;border-radius:12px;background:#080b09\n}\n.manualBadgeHead{display:flex;justify-content:space-between;align-items:center;gap:8px}\n.manualBadgeTitle{font-size:10px;font-weight:900;color:#d0dbd2;text-transform:uppercase;letter-spacing:.07em}\n.manualBadgeList{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;min-height:24px}\n.kickBadgeChip{\n  display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;\n  border:1px solid #3a573d;background:#101812;color:#d9f4dc;font-size:10px;font-weight:800\n}\n.kickBadgeIcon{\n  width:18px;height:18px;border-radius:5px;display:grid;place-items:center;\n  background:#f4f4f5;color:#111;font-size:8px;font-weight:950\n}\n.badgeMuted{font-size:10px;color:#7e8980;line-height:1.4}\n.badgeConfirmed{font-size:10px;color:#75df80;margin-top:7px}\n.badgeWaiting{font-size:10px;color:#e6c55f;margin-top:7px}\n.activityPre{min-height:270px;max-height:420px}\n.healthLine{font-size:10px;color:#8e9b90;line-height:1.5;margin-top:7px}\n.popupWait{font-size:12px;color:#53fc18;font-weight:800;margin-top:8px;display:none}.popupWait.show{display:block}\n.controlTabs{\n  grid-column:1/-1;position:sticky;top:8px;z-index:80;\n  display:flex;gap:7px;overflow-x:auto;padding:9px;\n  border:1px solid #263129;border-radius:15px;\n  background:rgba(8,11,9,.94);backdrop-filter:blur(14px);\n  box-shadow:0 14px 40px rgba(0,0,0,.24)\n}\n.controlTab{\n  appearance:none;white-space:nowrap;padding:9px 13px;border-radius:10px;\n  background:#0c100d;border:1px solid #29332b;color:#94a097;\n  font-size:11px;font-weight:850;cursor:pointer;transition:.15s ease\n}\n.controlTab:hover{border-color:#3d5140;color:#d5dfd6}\n.controlTab.active{\n  background:#53fc18;border-color:#53fc18;color:#061004;\n  box-shadow:0 0 20px rgba(83,252,24,.12)\n}\n.tabHidden{display:none!important}\n.tabSection{animation:tabIn .14s ease}\n@keyframes tabIn{from{opacity:.45;transform:translateY(3px)}to{opacity:1;transform:none}}\n.tabHint{grid-column:1/-1;font-size:10px;color:#768078;padding:0 4px;margin-top:-4px}\n.pipelineStrip{\n  margin:10px 0;padding:10px 12px;border:1px solid #2b3c2e;border-radius:11px;\n  background:#080c09;font-size:10px;color:#96a69a;line-height:1.55\n}\n.pipelineStrip b{color:#53fc18}\nmain[data-active-tab=\"dashboard\"] #master-control{grid-column:span 6}\nmain[data-active-tab=\"dashboard\"] #live-context{grid-column:span 6}\nmain[data-active-tab=\"dashboard\"] #latest-reply{grid-column:span 8}\nmain[data-active-tab=\"dashboard\"] #session-stats{grid-column:span 4}\nmain[data-active-tab=\"accounts\"] #ai-accounts{grid-column:1/-1}\nmain[data-active-tab=\"brain\"] #personality-panel{grid-column:1/-1}\nmain[data-active-tab=\"brain\"] #memory-manager,\nmain[data-active-tab=\"brain\"] #why-panel{grid-column:span 6}\nmain[data-active-tab=\"stream\"] #stream-channel{grid-column:span 4}\nmain[data-active-tab=\"stream\"] #live-chat{grid-column:span 8}\nmain[data-active-tab=\"stream\"] #stream-watch{grid-column:1/-1}\nmain[data-active-tab=\"manual\"] #manual-messages{grid-column:1/-1;min-height:420px}\nmain[data-active-tab=\"logs\"] #kick-test{grid-column:span 4}\nmain[data-active-tab=\"logs\"] #account-activity{grid-column:span 8}\nmain[data-active-tab=\"logs\"] #system-log{grid-column:1/-1}\n@media(max-width:900px){\n  main[data-active-tab] .card{grid-column:1/-1!important}\n  .controlTabs{top:4px}\n}\n.ipCheckerBox{\n  margin-top:10px;padding:10px;border-radius:12px;border:1px solid #263129;background:#080b09\n}\n.ipCheckerTop{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:7px}\n.ipCheckerTitle{font-size:11px;font-weight:850;color:#c8d3ca}\n.ipGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}\n.ipStat{padding:8px;border:1px solid #202923;border-radius:9px;background:#060806;min-width:0}\n.ipStat small{display:block;color:#7f8981;font-size:8px;text-transform:uppercase;letter-spacing:.08em}\n.ipStat b{display:block;margin-top:3px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.ipResult{font-size:10px;color:#89948b;margin-top:7px;min-height:16px}\n.ipResult.good{color:#75df80}.ipResult.bad{color:#ef8d8d}.ipResult.warn{color:#e6c55f}\n.personaGroup{border:1px solid #263129;border-radius:14px;background:#090c0a;padding:13px;margin:11px 0}\n.accountPersonaBox{margin-top:10px;border:1px solid #29362b;border-radius:12px;background:#070a08;overflow:hidden}\n.accountPersonaBox summary{cursor:pointer;padding:10px 11px;font-size:11px;font-weight:
