import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { buildBrowserProfile, calculateHumanTypingDelay, humanizeChatFormatting, impersonatedFetch, tlsImpersonationStatus } from "./fingerprint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 10000);

const KICK_CLIENT_ID = String(process.env.KICK_CLIENT_ID || "");
const KICK_CLIENT_SECRET = String(process.env.KICK_CLIENT_SECRET || "");
const KICK_REDIRECT_URI = String(process.env.KICK_REDIRECT_URI || "");
const DEFAULT_CHANNEL_SLUG = String(process.env.KICK_CHANNEL_SLUG || "");

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "");
const OPENAI_BRAIN_MODEL = String(process.env.OPENAI_BRAIN_MODEL || "gpt-5.5");
const OPENAI_REALTIME_TRANSCRIBE_MODEL = String(process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-4o-transcribe");
const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || "");
const ANTHROPIC_BRAIN_MODEL = String(process.env.ANTHROPIC_BRAIN_MODEL || "claude-sonnet-5");

// Cost estimates use current first-party API list prices and actual token usage returned by the APIs.
// They are a dashboard guardrail, not an invoice. Override with env vars if provider pricing changes.
const SONNET5_INPUT_USD_PER_M = Number(process.env.SONNET5_INPUT_USD_PER_M || 2);
const SONNET5_OUTPUT_USD_PER_M = Number(process.env.SONNET5_OUTPUT_USD_PER_M || 10);
const TRANSCRIBE_USD_PER_MIN = Number(process.env.TRANSCRIBE_USD_PER_MIN || 0.006);

const BOT_PERSONA = String(process.env.BOT_PERSONA || "casual gaming friend; short reactions; helpful when asked; no forced hype; no long paragraphs");
const AUTO_SEND_ENV = String(process.env.AUTO_SEND || "true").toLowerCase() === "true";
const MIN_REPLY_INTERVAL_MS = Math.max(3000, Number(process.env.MIN_REPLY_INTERVAL_MS || 12000));
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || "");
const MAX_ACCOUNTS = 10;

// ─── Anti-Detection / Fingerprint Spoofing ───
const ENABLE_FINGERPRINT_SPOOFING = String(process.env.ENABLE_FINGERPRINT_SPOOFING || "true").toLowerCase() !== "false";
const ENABLE_HUMAN_DELAY = String(process.env.ENABLE_HUMAN_DELAY || "true").toLowerCase() !== "false";
const ANON_FINGERPRINT = ENABLE_FINGERPRINT_SPOOFING ? buildBrowserProfile("kick-api-anonymous") : null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Standard per-account proxy routing. This is independent of the existing fingerprint module.
const proxyDispatchers = new Map();
function normalizeProxyUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
  raw = raw.replace(/^socks5h:\/\//i, "socks5://");
  const u = new URL(raw);
  if (!["http:", "https:", "socks:", "socks5:"].includes(u.protocol)) throw new Error("Proxy must use http://, https://, socks://, or socks5://");
  if (!u.hostname || !u.port) throw new Error("Proxy must include host and port.");
  return u.toString();
}
function proxyDisplay(value) {
  if (!value) return "direct";
  try {
    const u = new URL(value);
    return u.protocol + "//" + u.hostname + ":" + u.port;
  } catch { return "configured"; }
}
function getProxyDispatcher(proxyUrl) {
  const key = String(proxyUrl || "");
  if (!key) return null;
  let dispatcher = proxyDispatchers.get(key);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(key);
    proxyDispatchers.set(key, dispatcher);
  }
  return dispatcher;
}
async function accountProxyFetch(account, url, options = {}) {
  if (!account?.proxy) return null;
  return undiciFetch(url, { ...options, dispatcher: getProxyDispatcher(account.proxy) });
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const app = express();
app.set("trust proxy", 1);

const DASHBOARD_COOKIE = "cohost_dashboard_session";
const DASHBOARD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const dashboardSessions = new Map();

function constantTimeStringEqual(a, b) {
  const ah = crypto.createHash("sha256").update(String(a || "")).digest();
  const bh = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ah, bh);
}
function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return part.slice(idx + 1).trim(); }
  }
  return "";
}
function dashboardSessionValid(req) {
  const token = readCookie(req, DASHBOARD_COOKIE);
  if (!token) return false;
  const expiresAt = dashboardSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) { dashboardSessions.delete(token); return false; }
  dashboardSessions.set(token, Date.now() + DASHBOARD_SESSION_TTL_MS);
  return true;
}
function setDashboardCookie(req, res, token, maxAgeSeconds) {
  const secure = Boolean(req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https");
  const bits = [
    DASHBOARD_COOKIE + "=" + encodeURIComponent(token || ""),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds)),
  ];
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}
function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    if (req.path.startsWith("/api/")) return res.status(503).json({ ok: false, error: "DASHBOARD_PASSWORD is not configured." });
    return res.status(503).type("html").send("<h2>Dashboard locked</h2><p>Set <code>DASHBOARD_PASSWORD</code> in your environment and restart the app.</p>");
  }
  if (dashboardSessionValid(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Dashboard login required." });
  const returnTo = encodeURIComponent(req.originalUrl && req.originalUrl !== "/login" ? req.originalUrl : "/");
  return res.redirect("/login?returnTo=" + returnTo);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of dashboardSessions) if (expiresAt <= now) dashboardSessions.delete(token);
}, 10 * 60 * 1000).unref();

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultState = () => ({
  version: 2,
  settings: {
    provider: ["anthropic", "openai"].includes(process.env.DEFAULT_PROVIDER) ? process.env.DEFAULT_PROVIDER : "anthropic",
    humanReactionPercent: Math.max(0, Math.min(100, Number(process.env.DEFAULT_HUMAN_REACTION_PERCENT || 10))),
    autoSend: AUTO_SEND_ENV,
    viewerReplies: false,
    persona: BOT_PERSONA,
    captureFps: 60,
    visionFps: 6,
    visionWidth: 1280,
    visionBurstFrames: 4,
    streamBudgetDollars: Math.max(5, Math.min(50, Number(process.env.STREAM_BUDGET_DOLLARS || 20))),
  },
  kick: {
    accounts: [],
    activeAccountId: "",
    broadcasterId: "",
    channelSlug: DEFAULT_CHANNEL_SLUG,
  },
  metrics: {
    brainCalls: 0,
    sent: 0,
    skipped: 0,
    chatEvents: 0,
    ignoredChatEvents: 0,
  },
});

function deriveKey() {
  return crypto.createHash("sha256").update(SESSION_SECRET || "local-dev-only-key").digest();
}
function seal(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("base64"), tag: tag.toString("base64"), data: enc.toString("base64") };
}
function unseal(value) {
  if (!value?.iv || !value?.tag || !value?.data) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(out);
  } catch {
    return null;
  }
}
function newAccount(label = "") {
  const id = crypto.randomUUID();
  return {
    id,
    label: label || "Co-host account",
    token: null,
    userId: "",
    username: "",
    proxy: "",
    browserProfile: ENABLE_FINGERPRINT_SPOOFING ? buildBrowserProfile(id) : null,
    createdAt: Date.now(),
  };
}

let state = defaultState();
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const base = defaultState();
    const rawKick = raw.kick || {};
    const accounts = [];

    if (Array.isArray(rawKick.accounts)) {
      for (const item of rawKick.accounts.slice(0, MAX_ACCOUNTS)) {
        accounts.push({
          id: String(item.id || crypto.randomUUID()),
          label: String(item.label || "Co-host account"),
          token: item.tokenEncrypted ? unseal(item.tokenEncrypted) : (item.token || null),
          userId: String(item.userId || ""),
          username: String(item.username || ""),
          proxy: item.proxyEncrypted ? String(unseal(item.proxyEncrypted) || "") : String(item.proxy || ""),
          browserProfile: ENABLE_FINGERPRINT_SPOOFING ? buildBrowserProfile(item.id || "anon") : null,
          createdAt: Number(item.createdAt || Date.now()),
        });
      }
    } else if (rawKick.userId || rawKick.username || rawKick.tokenEncrypted || rawKick.token) {
      accounts.push({
        id: "legacy-account-1",
        label: "Account 1",
        token: rawKick.tokenEncrypted ? unseal(rawKick.tokenEncrypted) : (rawKick.token || null),
        userId: String(rawKick.userId || ""),
        username: String(rawKick.username || ""),
        proxy: "",
        browserProfile: ENABLE_FINGERPRINT_SPOOFING ? buildBrowserProfile("legacy-account-1") : null,
        createdAt: Date.now(),
      });
    }

    state = {
      ...base,
      ...raw,
      version: 2,
      settings: { ...base.settings, ...(raw.settings || {}) },
      kick: {
        ...base.kick,
        broadcasterId: String(rawKick.broadcasterId || ""),
        channelSlug: String(rawKick.channelSlug || DEFAULT_CHANNEL_SLUG),
        accounts,
        activeAccountId: String(rawKick.activeAccountId || accounts[0]?.id || ""),
      },
      metrics: { ...base.metrics, ...(raw.metrics || {}) },
    };
  } catch {}
}
function saveState() {
  const snapshot = JSON.parse(JSON.stringify(state));
  snapshot.kick.accounts = snapshot.kick.accounts.map(account => ({
    ...account,
    tokenEncrypted: seal(account.token),
    token: undefined,
    proxyEncrypted: seal(account.proxy),
    proxy: undefined,
    browserProfile: undefined, // regenerable from account.id
  }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
}
loadState();

const logs = [];
function log(message, extra = "") {
  const line = "[" + new Date().toLocaleTimeString() + "] " + String(message) + (extra ? " " + String(extra) : "");
  logs.push(line);
  if (logs.length > 300) logs.splice(0, logs.length - 300);
  console.log(line);
}

let transcripts = [];
let recentChat = [];
let latestFrames = [];
let latestContextAt = 0;
let lastReply = "";
let lastReplyAt = 0;
let lastBrain = null;
let streamSession = { isLive: false, startedAt: "", sessionId: "", title: "", category: "", uptimeSeconds: 0 };
let chatSubscription = { active: false, id: "", broadcasterUserId: "", error: "" };
let lastWebhookAt = 0;
let webhookIds = new Set();
let oauthPending = new Map();
let kickAppToken = null;

let costSession = {
  startedAt: 0,
  stoppedAt: 0,
  brainUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  anthropicCalls: 0,
  openaiCalls: 0,
  unpricedCalls: 0,
};
function resetCostSession() {
  costSession = { startedAt: Date.now(), stoppedAt: 0, brainUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, anthropicCalls: 0, openaiCalls: 0, unpricedCalls: 0 };
  log("Stream cost meter reset");
}
function stopCostSession() {
  if (costSession.startedAt && !costSession.stoppedAt) costSession.stoppedAt = Date.now();
}
function openaiBrainRates(model) {
  const m = String(model || "").toLowerCase();
  if (m === "gpt-5.5") return { input: 5, cached: 0.5, output: 30 };
  if (m === "gpt-5.6" || m === "gpt-5.6-sol") return { input: 2.5, cached: 0.25, output: 15 };
  if (m === "gpt-5.6-terra") return { input: 1, cached: 0.1, output: 6 };
  if (m === "gpt-5.6-luna") return { input: 0.1, cached: 0.01, output: 0.6 };
  return null;
}
function recordBrainUsage(provider, usage = {}) {
  const input = Number(usage.input_tokens || usage.inputTokens || 0);
  const output = Number(usage.output_tokens || usage.outputTokens || 0);
  const cached = Number(usage?.input_tokens_details?.cached_tokens || usage?.inputTokensDetails?.cachedTokens || usage.cache_read_input_tokens || 0);
  costSession.inputTokens += input;
  costSession.outputTokens += output;
  costSession.cachedInputTokens += cached;
  if (provider === "anthropic") {
    costSession.anthropicCalls++;
    costSession.brainUsd += (input * SONNET5_INPUT_USD_PER_M + output * SONNET5_OUTPUT_USD_PER_M) / 1_000_000;
    return;
  }
  if (provider === "openai") {
    costSession.openaiCalls++;
    const rates = openaiBrainRates(OPENAI_BRAIN_MODEL);
    if (!rates) { costSession.unpricedCalls++; return; }
    const uncached = Math.max(0, input - cached);
    costSession.brainUsd += (uncached * rates.input + cached * rates.cached + output * rates.output) / 1_000_000;
  }
}
function costStatus() {
  const budget = Math.max(5, Number(state.settings.streamBudgetDollars || 20));
  const endAt = costSession.stoppedAt || Date.now();
  const elapsedMs = costSession.startedAt ? Math.max(0, endAt - costSession.startedAt) : 0;
  const transcriptionUsd = (elapsedMs / 60000) * TRANSCRIBE_USD_PER_MIN;
  const totalUsd = costSession.brainUsd + transcriptionUsd;
  const ratio = budget > 0 ? totalUsd / budget : 0;
  const throttle = ratio >= 0.98 ? "paused" : ratio >= 0.92 ? "heavy" : ratio >= 0.85 ? "light" : "normal";
  return {
    budget,
    brainUsd: Number(costSession.brainUsd.toFixed(4)),
    transcriptionUsd: Number(transcriptionUsd.toFixed(4)),
    totalUsd: Number(totalUsd.toFixed(4)),
    remainingUsd: Number(Math.max(0, budget - totalUsd).toFixed(4)),
    percent: Math.min(999, Number((ratio * 100).toFixed(1))),
    throttle,
    startedAt: costSession.startedAt,
    inputTokens: costSession.inputTokens,
    outputTokens: costSession.outputTokens,
    cachedInputTokens: costSession.cachedInputTokens,
    anthropicCalls: costSession.anthropicCalls,
    openaiCalls: costSession.openaiCalls,
    unpricedCalls: costSession.unpricedCalls,
  };
}
function effectiveVisionBurst() {
  const desired = Math.round(clamp(state.settings.visionBurstFrames, 1, 5));
  const c = costStatus();
  if (c.throttle === "paused") return 0;
  if (c.throttle === "heavy") return Math.min(desired, 1);
  if (c.throttle === "light") return Math.min(desired, 2);
  return desired;
}
let kickPublicKeyCache = "";

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n))); }
function cleanText(s, max = 500) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
function formatOutgoing(s) {
  return cleanText(s, 500)
    .replace(/[\u2010-\u2015\u2212]/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function activeAccount() {
  return state.kick.accounts.find(a => a.id === state.kick.activeAccountId) || null;
}
function connectedAccounts() {
  return state.kick.accounts.filter(a => Boolean(a.token?.access_token));
}
function clearContext(reason) {
  transcripts = [];
  recentChat = [];
  latestFrames = [];
  latestContextAt = 0;
  lastBrain = null;
  log("Context reset:", reason);
}
function recentTranscriptText() { return transcripts.slice(-12).map(x => x.text).join(" | "); }
function recentChatText() { return recentChat.slice(-20).map(x => "@" + x.username + ": " + x.content).join("\n"); }
function publicStatus() {
  const active = activeAccount();
  return {
    ok: true,
    version: "sonnet-openai-rework-2.1-high-vision-budget",
    providers: {
      anthropic: { configured: Boolean(ANTHROPIC_API_KEY), model: ANTHROPIC_BRAIN_MODEL },
      openai: { configured: Boolean(OPENAI_API_KEY), model: OPENAI_BRAIN_MODEL },
      realtime: { configured: Boolean(OPENAI_API_KEY), model: OPENAI_REALTIME_TRANSCRIBE_MODEL },
    },
    settings: state.settings,
    kick: {
      maxAccounts: MAX_ACCOUNTS,
      activeAccountId: state.kick.activeAccountId,
      activeUsername: active?.username || "",
      accounts: state.kick.accounts.map(a => ({
        id: a.id,
        label: a.label,
        connected: Boolean(a.token?.access_token),
        username: a.username,
        userId: a.userId,
        proxyConfigured: Boolean(a.proxy),
        proxyDisplay: proxyDisplay(a.proxy),
        active: a.id === state.kick.activeAccountId,
      })),
      broadcasterId: state.kick.broadcasterId,
      channelSlug: state.kick.channelSlug,
      subscription: chatSubscription,
    },
    streamSession,
    antiDetection: ENABLE_FINGERPRINT_SPOOFING ? {
      enabled: true,
      humanDelay: ENABLE_HUMAN_DELAY,
      tls: tlsImpersonationStatus(),
      activeProfile: active?.browserProfile ? `Chrome ${active.browserProfile.chromeMajor} • ${active.browserProfile.platform} • ${active.browserProfile.typingWpm} WPM` : "none",
    } : { enabled: false },
    runtime: {
      lastHeard: transcripts.at(-1)?.text || "",
      transcriptCount: transcripts.length,
      chatCount: recentChat.length,
      latestFrameAt: latestFrames.at(-1)?.at || 0,
      frameCount: latestFrames.length,
      latestContextAt,
      lastReply,
      lastReplyAt,
      lastBrain,
      lastWebhookAt,
      metrics: state.metrics,
      logs: logs.slice(-80),
      recentChat: recentChat.slice(-60),
      cost: costStatus(),
    },
  };
}

async function kickJson(url, options = {}, account = null) {
  let r;
  if (account?.proxy) {
    r = await accountProxyFetch(account, url, options);
  } else if (ENABLE_FINGERPRINT_SPOOFING && ANON_FINGERPRINT) {
    r = await impersonatedFetch(null, url, options, { profile: ANON_FINGERPRINT });
  } else {
    r = await fetch(url, options);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Kick API " + r.status + ": " + JSON.stringify(data));
  return data;
}
async function getKickAppToken() {
  if (kickAppToken?.access_token && (!kickAppToken.expiresAt || Date.now() < kickAppToken.expiresAt - 60000)) return kickAppToken.access_token;
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) throw new Error("Missing Kick client credentials.");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET });
  const data = await kickJson("https://id.kick.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  kickAppToken = { ...data, expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0 };
  return data.access_token;
}
async function identifyKickUser(accessToken, account = null) {
  const data = await kickJson("https://api.kick.com/public/v1/users", { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" } }, account);
  const item = Array.isArray(data?.data) ? data.data[0] : data?.data;
  return { userId: String(item?.user_id || item?.id || ""), username: String(item?.name || item?.username || item?.slug || "") };
}
async function refreshKickToken(accountId = state.kick.activeAccountId) {
  const account = state.kick.accounts.find(a => a.id === accountId);
  if (!account?.token?.access_token) throw new Error("Connect and select a Kick co-host account first.");
  if (!account.token.expires_at || Date.now() < Number(account.token.expires_at) - 60000) return account.token;
  if (!account.token.refresh_token) throw new Error("Kick token expired. Reconnect @" + (account.username || account.label) + ".");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.token.refresh_token,
    client_id: KICK_CLIENT_ID,
    client_secret: KICK_CLIENT_SECRET,
  });
  const data = await kickJson("https://id.kick.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, account);
  account.token = { ...data, expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0 };
  saveState();
  return account.token;
}
async function resolveChannel(slug) {
  const token = await refreshKickToken();
  const clean = cleanText(slug, 100);
  if (!clean) throw new Error("Enter the streamer Kick username.");
  const account = activeAccount();
  const data = await kickJson("https://api.kick.com/public/v1/channels?slug=" + encodeURIComponent(clean), { headers: { Authorization: "Bearer " + token.access_token, Accept: "application/json" } }, account);
  const item = Array.isArray(data?.data) ? data.data[0] : data?.data;
  const id = String(item?.broadcaster_user_id || "");
  if (!id) throw new Error("Kick returned no broadcaster_user_id.");
  if (state.kick.broadcasterId && state.kick.broadcasterId !== id) clearContext("watched channel changed");
  state.kick.broadcasterId = id;
  state.kick.channelSlug = clean;
  chatSubscription = { active: false, id: "", broadcasterUserId: id, error: "" };
  saveState();
  return { broadcasterId: id, channelSlug: clean };
}
async function queryStreamSession() {
  if (!state.kick.broadcasterId || !activeAccount()?.token?.access_token) return streamSession;
  const token = await refreshKickToken();
  const account = activeAccount();
  const data = await kickJson("https://api.kick.com/public/v1/channels?broadcaster_user_id=" + encodeURIComponent(state.kick.broadcasterId), { headers: { Authorization: "Bearer " + token.access_token, Accept: "application/json" } }, account);
  const item = Array.isArray(data?.data) ? data.data[0] : data?.data;
  const stream = item?.stream || {};
  const isLive = Boolean(stream?.is_live);
  const startedAt = String(stream?.start_time || "");
  const startMs = Date.parse(startedAt);
  const sessionId = isLive ? state.kick.broadcasterId + ":" + startedAt : "";
  const next = {
    isLive,
    startedAt,
    sessionId,
    title: String(item?.stream_title || ""),
    category: String(item?.category?.name || ""),
    uptimeSeconds: isLive && Number.isFinite(startMs) ? Math.max(0, Math.floor((Date.now() - startMs) / 1000)) : 0,
  };
  if (streamSession.sessionId && next.sessionId && streamSession.sessionId !== next.sessionId) clearContext("new live session started");
  if (streamSession.isLive && !next.isLive) clearContext("stream went offline");
  streamSession = next;
  return next;
}
async function postKickChat(content, replyToMessageId = "") {
  const account = activeAccount();
  if (!account) throw new Error("Select an active co-host account first.");

  // Structural cleanup first
  const clean = formatOutgoing(content);
  // Then humanize the formatting (casual lowercase, trailing period removal, etc.)
  const text = ENABLE_FINGERPRINT_SPOOFING ? humanizeChatFormatting(clean) : clean;

  if (!text) throw new Error("No message to send.");

  // Human typing delay before sending (reads like a real person typed it)
  if (ENABLE_HUMAN_DELAY && account.browserProfile) {
    const delay = calculateHumanTypingDelay(text, account.browserProfile);
    await sleep(delay);
  }

  const token = await refreshKickToken(account.id);
  if (!state.kick.broadcasterId) throw new Error("Resolve the streamer channel first.");
  const payload = { broadcaster_user_id: Number(state.kick.broadcasterId), content: text, type: "user" };
  if (replyToMessageId) payload.reply_to_message_id = String(replyToMessageId);

  // Use account-specific fingerprint for the chat send
  const chatUrl = "https://api.kick.com/public/v1/chat";
  const chatOpts = {
    method: "POST",
    headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  };

  let data;
  if (account.proxy) {
    data = await kickJson(chatUrl, chatOpts, account);
  } else if (ENABLE_FINGERPRINT_SPOOFING && account.browserProfile) {
    const r = await impersonatedFetch(account, chatUrl, chatOpts, { profile: account.browserProfile });
    data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Kick API " + r.status + ": " + JSON.stringify(data));
  } else {
    data = await kickJson(chatUrl, chatOpts);
  }

  lastReply = text;
  lastReplyAt = Date.now();
  state.metrics.sent++;
  saveState();
  log("Kick sent as @" + (account.username || account.label) + ":", text);
  return data;
}

const KICK_PUBLIC_KEY_FALLBACK = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;
async function getKickPublicKey() {
  if (kickPublicKeyCache) return kickPublicKeyCache;
  try {
    const token = await getKickAppToken();
    const data = await kickJson("https://api.kick.com/public/v1/public-key", { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (data?.data?.public_key) return (kickPublicKeyCache = data.data.public_key);
  } catch {}
  return (kickPublicKeyCache = KICK_PUBLIC_KEY_FALLBACK);
}
async function verifyKickWebhook(req, raw) {
  const id = String(req.headers["kick-event-message-id"] || "");
  const ts = String(req.headers["kick-event-message-timestamp"] || "");
  const sig = String(req.headers["kick-event-signature"] || "");
  if (!id || !ts || !sig) return false;
  const key = await getKickPublicKey();
  return crypto.verify("RSA-SHA256", Buffer.from(id + "." + ts + "." + raw.toString("utf8"), "utf8"), key, Buffer.from(sig, "base64"));
}
async function ensureChatSubscription() {
  const id = Number(state.kick.broadcasterId);
  if (!id) throw new Error("Resolve the streamer channel first.");
  const token = await getKickAppToken();
  try {
    const list = await kickJson("https://api.kick.com/public/v1/events/subscriptions?broadcaster_user_id=" + id, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    const existing = (Array.isArray(list?.data) ? list.data : []).find(x => x.event === "chat.message.sent" && Number(x.broadcaster_user_id) === id);
    if (existing) {
      chatSubscription = { active: true, id: String(existing.id || existing.subscription_id || ""), broadcasterUserId: String(id), existing: true, error: "" };
      return chatSubscription;
    }
  } catch {}
  try {
    const created = await kickJson("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ broadcaster_user_id: id, events: [{ name: "chat.message.sent", version: 1 }], method: "webhook" }),
    });
    const item = Array.isArray(created?.data) ? created.data[0] : created?.data || {};
    chatSubscription = { active: true, id: String(item?.subscription_id || item?.id || ""), broadcasterUserId: String(id), existing: false, error: "" };
    return chatSubscription;
  } catch (e) {
    chatSubscription = { active: false, id: "", broadcasterUserId: String(id), error: String(e.message || e) };
    throw e;
  }
}

function extractBase64Image(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}
function safeJSON(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}
function brainPrompt({ transcript, eventType = "streamer_speech", viewerMessage = null }) {
  return [
    "You are the decision-and-reply brain for a disclosed AI co-host in a gaming livestream.",
    "Persona: " + state.settings.persona,
    "Keep chat replies short, casual, specific to what is happening, usually 2-14 words. Avoid polished assistant language.",
    "Do not invent game events, facts, or what you can see. Use only the supplied context and attached recent frames.",
    "The attached frames, when present, are chronological recent snapshots ending with the newest frame.",
    "A low reaction score is fine for ordinary gaming moments. Score 0-100 for how natural it would be for a regular co-host to say something now.",
    "If the streamer directly asks a question or clearly addresses the co-host, should_reply should normally be true.",
    "Viewer chat is context. Do not reply to a viewer unless event_type is viewer_chat and the message genuinely invites a response.",
    "Return ONLY compact JSON with keys: should_reply (boolean), reaction_score (0-100 integer), reply (string), reason (short string).",
    "",
    "event_type: " + eventType,
    "current streamer speech: " + (transcript || "(none)"),
    "viewer event: " + (viewerMessage ? "@" + viewerMessage.username + ": " + viewerMessage.content : "(none)"),
    "recent streamer speech: " + (recentTranscriptText() || "(none)"),
    "recent current-stream chat:\n" + (recentChatText() || "(none)"),
    "stream title: " + (streamSession.title || "(unknown)"),
    "stream category/game: " + (streamSession.category || "(unknown)"),
  ].join("\n");
}
async function callAnthropicBrain(ctx) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const content = [{ type: "text", text: brainPrompt(ctx) }];
  const burst = effectiveVisionBurst();
  for (const frame of (burst > 0 ? latestFrames.slice(-burst) : [])) {
    const image = extractBase64Image(frame.dataUrl);
    if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_BRAIN_MODEL,
      max_tokens: 220,
      thinking: { type: "disabled" },
      system: "You are a fast livestream chat decision engine. Output only the requested JSON.",
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + JSON.stringify(data));
  const text = (Array.isArray(data?.content) ? data.content : []).filter(x => x.type === "text").map(x => x.text).join("\n");
  return { result: safeJSON(text), usage: data?.usage || {} };
}
async function callOpenAIBrain(ctx) {
  if (!openai) throw new Error("OPENAI_API_KEY is not configured.");
  const content = [{ type: "input_text", text: brainPrompt(ctx) }];
  const burst = effectiveVisionBurst();
  for (const frame of (burst > 0 ? latestFrames.slice(-burst) : [])) {
    if (extractBase64Image(frame.dataUrl)) content.push({ type: "input_image", image_url: frame.dataUrl, detail: "low" });
  }
  const r = await openai.responses.create({
    model: OPENAI_BRAIN_MODEL,
    instructions: "You are a fast livestream chat decision engine. Output only the requested JSON.",
    input: [{ role: "user", content }],
    max_output_tokens: 220,
  });
  return { result: safeJSON(r.output_text), usage: r?.usage || {} };
}
async function runBrain(ctx) {
  const beforeCost = costStatus();
  if (beforeCost.throttle === "paused") {
    const threshold = Number(state.settings.humanReactionPercent || 0);
    lastBrain = { provider: state.settings.provider, score: 0, threshold, shouldReply: false, reason: "stream budget guard reached; auto brain paused", reply: "" };
    state.metrics.skipped++;
    log("Budget guard:", "$" + beforeCost.totalUsd.toFixed(2) + " / $" + beforeCost.budget.toFixed(2) + " • auto brain paused");
    return { action: "skip", ...lastBrain, cost: beforeCost };
  }
  state.metrics.brainCalls++;
  const provider = state.settings.provider;
  const called = provider === "openai" ? await callOpenAIBrain(ctx) : await callAnthropicBrain(ctx);
  const result = called?.result;
  recordBrainUsage(provider, called?.usage || {});
  if (!result || typeof result !== "object") throw new Error(provider + " returned invalid JSON.");
  const score = Math.round(clamp(result.reaction_score, 0, 100));
  const reply = formatOutgoing(result.reply || "");
  const directlyAddressed = /\b(ai|cohost|co-host|chatbot|bot)\b/i.test(ctx.transcript || "") || /\?\s*$/.test(ctx.transcript || "");
  const threshold = Number(state.settings.humanReactionPercent || 0);
  const allowedByScore = score >= threshold || directlyAddressed;
  const shouldReply = Boolean(result.should_reply) && allowedByScore && Boolean(reply);
  lastBrain = { provider, score, threshold, shouldReply, reason: cleanText(result.reason, 160), reply };
  latestContextAt = Date.now();
  saveState();
  if (!shouldReply) {
    state.metrics.skipped++;
    saveState();
    log("Brain quiet:", score + "% at threshold " + threshold + "% • " + lastBrain.reason);
    return { action: "skip", ...lastBrain };
  }
  if (Date.now() - lastReplyAt < MIN_REPLY_INTERVAL_MS && !directlyAddressed) {
    state.metrics.skipped++;
    saveState();
    return { action: "skip", ...lastBrain, reason: "reply cooldown" };
  }
  if (!state.settings.autoSend) return { action: "preview", ...lastBrain };
  await postKickChat(reply, ctx.viewerMessage?.messageId || "");
  return { action: "sent", ...lastBrain };
}

app.post("/webhooks/kick", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  try {
    if (!await verifyKickWebhook(req, raw)) return res.status(401).send("invalid signature");
    const wid = String(req.headers["kick-event-message-id"] || "");
    if (wid && webhookIds.has(wid)) return res.status(200).send("duplicate");
    if (wid) webhookIds.add(wid);
    if (webhookIds.size > 500) webhookIds = new Set([...webhookIds].slice(-250));

    const type = String(req.headers["kick-event-type"] || "");
    const payload = JSON.parse(raw.toString("utf8") || "{}");
    res.status(200).send("ok");
    if (type !== "chat.message.sent") return;

    const incomingBroadcaster = String(payload?.broadcaster?.user_id || "");
    if (state.kick.broadcasterId && incomingBroadcaster && incomingBroadcaster !== state.kick.broadcasterId) {
      state.metrics.ignoredChatEvents++;
      saveState();
      return;
    }
    const eventTime = Date.parse(String(payload?.created_at || ""));
    const sessionStart = Date.parse(String(streamSession.startedAt || ""));
    if (streamSession.isLive && Number.isFinite(eventTime) && Number.isFinite(sessionStart) && eventTime < sessionStart - 5000) {
      state.metrics.ignoredChatEvents++;
      saveState();
      return;
    }

    const username = cleanText(payload?.sender?.username, 100);
    const content = cleanText(payload?.content, 500);
    if (!username || !content) return;
    const ownNames = new Set(connectedAccounts().map(a => a.username.toLowerCase()).filter(Boolean));
    if (ownNames.has(username.toLowerCase())) return;

    const item = {
      messageId: String(payload?.message_id || wid || crypto.randomUUID()),
      username,
      content,
      createdAt: String(payload?.created_at || new Date().toISOString()),
      receivedAt: Date.now(),
      broadcasterUserId: incomingBroadcaster,
    };
    recentChat.push(item);
    if (recentChat.length > 100) recentChat.splice(0, recentChat.length - 100);
    lastWebhookAt = Date.now();
    state.metrics.chatEvents++;
    saveState();

    if (state.settings.viewerReplies && Date.now() - lastReplyAt >= MIN_REPLY_INTERVAL_MS) {
      setImmediate(async () => {
        try {
          const result = await runBrain({ transcript: "", eventType: "viewer_chat", viewerMessage: item });
          if (result.action === "sent") log("Viewer reply:", "@" + username + " -> " + result.reply);
        } catch (e) {
          log("Viewer brain error:", e.message || e);
        }
      });
    }
  } catch (e) {
    console.error("Kick webhook error:", e);
    if (!res.headersSent) res.status(500).send("webhook error");
  }
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

const LOGIN_HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Co-host Login</title><style>body{margin:0;background:#050a10;color:#edf8ff;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.box{width:min(390px,calc(100vw - 28px));background:#09131e;border:1px solid #173044;border-radius:16px;padding:22px}h1{font-size:22px;margin:0 0 6px}.sub{font-size:12px;color:#7692a6;margin-bottom:18px}input,button{width:100%;box-sizing:border-box;border-radius:9px;padding:11px;font:inherit}input{background:#03090e;border:1px solid #1a4058;color:#fff;margin:7px 0 10px}button{border:1px solid #1bb7ea;background:#0b88b5;color:#fff;font-weight:800;cursor:pointer}.err{font-size:12px;color:#ff9aaa;margin-top:10px}.note{font-size:11px;color:#7692a6;margin-top:12px}</style></head><body><form class="box" method="post" action="/login"><h1>AI Co-host</h1><div class="sub">Dashboard access</div><input type="hidden" name="returnTo" value="__RETURN_TO__"><label>Password</label><input type="password" name="password" autocomplete="current-password" autofocus required><button type="submit">Sign in</button>__ERROR__<div class="note">Uses your DASHBOARD_PASSWORD environment variable.</div></form></body></html>`;
function loginPage(returnTo = "/", error = "") {
  const safeReturn = String(returnTo || "/").startsWith("/") && !String(returnTo || "").startsWith("//") ? String(returnTo) : "/";
  const esc = (v) => String(v || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  return LOGIN_HTML.replace("__RETURN_TO__", esc(safeReturn)).replace("__ERROR__", error ? '<div class="err">' + esc(error) + "</div>" : "");
}
app.get("/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.status(503).type("html").send(loginPage("/", "DASHBOARD_PASSWORD is not configured on the server."));
  if (dashboardSessionValid(req)) return res.redirect("/");
  res.type("html").send(loginPage(req.query.returnTo || "/"));
});
app.post("/login", (req, res) => {
  const returnTo = String(req.body?.returnTo || "/");
  if (!DASHBOARD_PASSWORD) return res.status(503).type("html").send(loginPage(returnTo, "DASHBOARD_PASSWORD is not configured on the server."));
  if (!constantTimeStringEqual(req.body?.password, DASHBOARD_PASSWORD)) return res.status(401).type("html").send(loginPage(returnTo, "Incorrect password."));
  const token = crypto.randomBytes(32).toString("base64url");
  dashboardSessions.set(token, Date.now() + DASHBOARD_SESSION_TTL_MS);
  setDashboardCookie(req, res, token, DASHBOARD_SESSION_TTL_MS / 1000);
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  res.redirect(safeReturn);
});
app.post("/logout", (req, res) => {
  const token = readCookie(req, DASHBOARD_COOKIE);
  if (token) dashboardSessions.delete(token);
  setDashboardCookie(req, res, "", 0);
  res.redirect("/login");
});

// Keep provider webhooks, health checks, and the OAuth callback reachable without dashboard login.
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/auth/kick/callback") return next();
  return requireDashboardAuth(req, res, next);
});

app.get("/health", (_req, res) => res.json({ ok: true, version: "sonnet-openai-rework-2.2" }));
app.get("/api/status", async (_req, res) => {
  try { await queryStreamSession(); } catch (e) { log("Stream status:", e.message || e); }
  res.json(publicStatus());
});

app.post("/api/accounts/add", (_req, res) => {
  if (state.kick.accounts.length >= MAX_ACCOUNTS) return res.status(400).json({ ok: false, error: "Maximum of 10 accounts reached." });
  const account = newAccount("Account " + (state.kick.accounts.length + 1));
  state.kick.accounts.push(account);
  if (!state.kick.activeAccountId) state.kick.activeAccountId = account.id;
  saveState();
  res.json({ ok: true, accountId: account.id });
});
app.post("/api/accounts/:id/active", (req, res) => {
  const account = state.kick.accounts.find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: "Account not found." });
  state.kick.activeAccountId = account.id;
  saveState();
  log("Active sender:", account.username ? "@" + account.username : account.label);
  res.json({ ok: true });
});
app.post("/api/accounts/:id/proxy", (req, res) => {
  try {
    const account = state.kick.accounts.find(a => a.id === req.params.id);
    if (!account) return res.status(404).json({ ok: false, error: "Account not found." });
    const next = normalizeProxyUrl(req.body?.proxy || "");
    account.proxy = next;
    saveState();
    log("Account proxy:", (account.username ? "@" + account.username : account.label) + " → " + proxyDisplay(next));
    res.json({ ok: true, configured: Boolean(next), display: proxyDisplay(next) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});
app.post("/api/accounts/:id/disconnect", (req, res) => {
  const account = state.kick.accounts.find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: "Account not found." });
  account.token = null;
  account.userId = "";
  account.username = "";
  saveState();
  res.json({ ok: true });
});
app.delete("/api/accounts/:id", (req, res) => {
  const before = state.kick.accounts.length;
  state.kick.accounts = state.kick.accounts.filter(a => a.id !== req.params.id);
  if (state.kick.accounts.length === before) return res.status(404).json({ ok: false, error: "Account not found." });
  if (state.kick.activeAccountId === req.params.id) state.kick.activeAccountId = state.kick.accounts[0]?.id || "";
  saveState();
  res.json({ ok: true });
});

function kickOAuthResultPage(ok, message, accountId = "") {
  const safeMessage = cleanText(message || "", 800);
  const payload = JSON.stringify({ type: "kick-oauth-complete", ok: Boolean(ok), accountId: String(accountId || ""), message: safeMessage }).replace(/</g, "\\u003c");
  const title = ok ? "Kick account connected" : "Kick account not connected";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;background:#07111a;color:#edf8ff;padding:30px}div{max-width:620px;margin:10vh auto;background:#0b1824;border:1px solid #173044;border-radius:14px;padding:22px}a{color:#55d6ff}</style></head><body><div><h2>${title}</h2><p>${safeMessage.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</p><p><a href="/">Return to dashboard</a></p></div><script>try{if(window.opener&&!window.opener.closed)window.opener.postMessage(${payload},location.origin)}catch(e){}${ok ? 'setTimeout(()=>window.close(),700);' : ''}</script></body></html>`;
}

app.get("/auth/kick/start", (req, res) => {
  try {
    if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET || !KICK_REDIRECT_URI) throw new Error("Missing Kick OAuth environment variables.");
    const accountId = String(req.query.accountId || state.kick.activeAccountId || "");
    const account = state.kick.accounts.find(a => a.id === accountId);
    if (!account) throw new Error("Add an account slot first.");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const oauthState = crypto.randomBytes(24).toString("base64url");
    oauthPending.set(oauthState, { verifier, accountId, createdAt: Date.now() });
    for (const [key, value] of oauthPending) if (Date.now() - value.createdAt > 10 * 60 * 1000) oauthPending.delete(key);
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: KICK_CLIENT_ID,
      redirect_uri: KICK_REDIRECT_URI,
      scope: "user:read channel:read chat:write",
      state: oauthState,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.redirect("https://id.kick.com/oauth/authorize?" + qs.toString());
  } catch (e) {
    res.status(500).send("Kick authorization error: " + cleanText(e.message || e, 500));
  }
});
app.get("/auth/kick/callback", async (req, res) => {
  try {
    const oauthState = String(req.query.state || "");
    const pending = oauthPending.get(oauthState);
    oauthPending.delete(oauthState);
    if (!pending) throw new Error("OAuth state expired or invalid.");
    const account = state.kick.accounts.find(a => a.id === pending.accountId);
    if (!account) throw new Error("Account slot no longer exists.");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(req.query.code || ""),
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      redirect_uri: KICK_REDIRECT_URI,
      code_verifier: pending.verifier,
    });
    const token = await kickJson("https://id.kick.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, account);
    const identity = await identifyKickUser(token.access_token, account);
    const duplicate = state.kick.accounts.find(a => a.id !== account.id && a.userId && a.userId === identity.userId && a.token?.access_token);
    if (duplicate) {
      const msg = "@" + (identity.username || "this Kick account") + " is already connected in " + duplicate.label + ". Sign out/switch Kick accounts in the OAuth browser, then click Connect on " + account.label + " again.";
      log("Kick duplicate account blocked:", msg);
      return res.status(409).type("html").send(kickOAuthResultPage(false, msg, account.id));
    }
    account.token = { ...token, expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : 0 };
    account.userId = identity.userId;
    account.username = identity.username;
    state.kick.activeAccountId = account.id;
    saveState();
    log("Kick connected:", "@" + (identity.username || "unknown") + " → " + account.label);
    res.type("html").send(kickOAuthResultPage(true, "Connected @" + (identity.username || "unknown") + " to " + account.label + ".", account.id));
  } catch (e) {
    res.status(500).type("html").send(kickOAuthResultPage(false, "Kick authorization failed: " + cleanText(e.message || e, 700)));
  }
});

app.post("/api/resolve-channel", async (req, res) => {
  try {
    const out = await resolveChannel(req.body?.slug || state.kick.channelSlug || DEFAULT_CHANNEL_SLUG);
    await queryStreamSession().catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
app.post("/api/chat/subscribe", async (_req, res) => {
  try { res.json({ ok: true, ...(await ensureChatSubscription()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  if (["anthropic", "openai"].includes(body.provider)) state.settings.provider = body.provider;
  if (body.humanReactionPercent !== undefined) state.settings.humanReactionPercent = Math.round(clamp(body.humanReactionPercent, 0, 100));
  if (body.autoSend !== undefined) state.settings.autoSend = Boolean(body.autoSend);
  if (body.viewerReplies !== undefined) state.settings.viewerReplies = Boolean(body.viewerReplies);
  if (body.persona !== undefined) state.settings.persona = cleanText(body.persona, 600) || BOT_PERSONA;
  if (body.captureFps !== undefined) state.settings.captureFps = [30, 60].includes(Number(body.captureFps)) ? Number(body.captureFps) : 60;
  if (body.visionFps !== undefined) state.settings.visionFps = clamp(body.visionFps, 1, 8);
  if (body.visionWidth !== undefined) state.settings.visionWidth = [720, 960, 1280, 1600].includes(Number(body.visionWidth)) ? Number(body.visionWidth) : 1280;
  if (body.visionBurstFrames !== undefined) state.settings.visionBurstFrames = Math.round(clamp(body.visionBurstFrames, 1, 5));
  if (body.streamBudgetDollars !== undefined) state.settings.streamBudgetDollars = Math.round(clamp(body.streamBudgetDollars, 5, 50));
  saveState();
  res.json({ ok: true, settings: state.settings });
});
app.post("/api/cost/reset", (_req, res) => {
  resetCostSession();
  res.json({ ok: true, cost: costStatus() });
});
app.post("/api/watch/stop", (_req, res) => {
  stopCostSession();
  res.json({ ok: true, cost: costStatus() });
});
app.post("/api/context/reset", (_req, res) => {
  clearContext("manual reset");
  res.json({ ok: true });
});
app.post("/api/manual-send", async (req, res) => {
  try {
    await postKickChat(req.body?.content || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
app.post("/api/brain", async (req, res) => {
  try {
    const transcript = cleanText(req.body?.transcript, 1000);
    if (transcript) {
      transcripts.push({ text: transcript, at: Date.now() });
      if (transcripts.length > 80) transcripts.splice(0, transcripts.length - 80);
      log("Heard:", transcript);
    }
    const incomingFrames = Array.isArray(req.body?.frameDataUrls) ? req.body.frameDataUrls.slice(-5) : [req.body?.frameDataUrl].filter(Boolean);
    const validFrames = incomingFrames.filter(x => extractBase64Image(String(x || ""))).map(dataUrl => ({ dataUrl: String(dataUrl), at: Date.now() }));
    if (validFrames.length) latestFrames = validFrames.slice(-5);
    await queryStreamSession().catch(() => {});
    const result = await runBrain({ transcript, eventType: "streamer_speech" });
    res.json({ ok: true, ...result, context: { transcripts: transcripts.length, chat: recentChat.length, frameAt: latestFrames.at(-1)?.at || 0, frames: latestFrames.length } });
  } catch (e) {
    log("Brain error:", e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});
app.post("/api/realtime-token", async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
    const sessionConfig = {
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: OPENAI_REALTIME_TRANSCRIBE_MODEL,
              prompt: "Gaming livestream audio. Accurately transcribe casual speech, game terms, names, slang, and short reactions.",
              language: "en",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.48,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
            },
          },
        },
      },
    };
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(sessionConfig),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Realtime token error (" + r.status + "): " + JSON.stringify(data));
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Co-host</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;--bg:#050a10;--card:#09131e;--line:#173044;--cyan:#35c8f4;--green:#50e89a;--muted:#7692a6;--text:#edf8ff;--red:#ff8292}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{width:min(1420px,calc(100vw - 24px));margin:14px auto 50px;display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}
header,.card{background:linear-gradient(180deg,#0b1824,#07111a);border:1px solid var(--line);border-radius:16px}header{grid-column:1/-1;padding:18px;display:flex;justify-content:space-between;gap:12px;align-items:center}.brand{font-size:22px;font-weight:900}.sub{font-size:12px;color:var(--muted);margin-top:4px}
.card{padding:15px;min-width:0}.span12{grid-column:1/-1}.span6{grid-column:span 6}.h{font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#8ddffc;margin-bottom:10px}.sectionGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,select,textarea,button{font:inherit}input,select,textarea{width:100%;background:#03090e;border:1px solid #1a4058;color:#fff;border-radius:9px;padding:9px}textarea{min-height:72px;resize:vertical}button,.btn{border:1px solid #23516a;background:#0b2231;color:#effaff;padding:9px 12px;border-radius:9px;font-weight:800;cursor:pointer;text-decoration:none}.primary{background:#0b88b5;border-color:#1bb7ea}.danger{border-color:#74313d;color:#ffb2be}.small{padding:6px 9px;font-size:11px}.ghost{background:#06131d}
.label{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:#6e94aa;margin:8px 0 4px}.status{font-size:11px;color:#9ab3c3;min-height:17px;margin-top:6px;word-break:break-word}.big{font-size:19px;font-weight:900}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.ok{color:#70f0ac}.warn{color:#ffd083}.bad{color:#ff9aaa}
.chips{display:flex;gap:7px;flex-wrap:wrap}.chip{font-size:9px;font-weight:900;border:1px solid #17384d;border-radius:999px;padding:6px 9px;color:#607f92;background:#061019}.chip.on{color:#cffff0;border-color:#2b8258;background:#09231a}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#375264;margin-right:5px}.chip.on .dot{background:var(--green)}
.accounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:9px}.acct{border:1px solid #15364b;background:#040d14;border-radius:10px;padding:9px}.acct.active{border-color:#2f9866;background:#071a13}.acctTop{display:flex;justify-content:space-between;gap:8px;align-items:center}.acctName{font-weight:900;font-size:12px}.acctMeta{font-size:10px;color:#7896a8;margin-top:3px}.acctBtns{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.proxyRow{display:grid;grid-template-columns:1fr auto auto;gap:5px;margin-top:7px}.proxyRow input{font-size:10px;padding:7px}
.rangeWrap{display:grid;grid-template-columns:1fr 56px;gap:8px;align-items:center}input[type=range]{padding:0}.pct{font-weight:900;text-align:center;border:1px solid #1a4058;border-radius:8px;padding:6px;background:#02080d}.toggle{display:flex;align-items:center;gap:7px;font-size:11px;color:#a5bdca}.toggle input{width:auto}
.preview{width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;border-radius:11px;margin-top:9px;border:1px solid #173044}.feed{background:#02070b;border:1px solid #15364b;border-radius:9px;padding:9px;max-height:230px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.4}.reply{background:#02070b;border:1px solid #15364b;border-radius:9px;padding:11px;min-height:47px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:9px}.stat{border:1px solid #15364b;background:#040c12;border-radius:9px;padding:9px}.stat b{display:block;font-size:17px}.stat span{font-size:8px;color:#668aa0}.activityTop{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:9px}
@media(max-width:900px){.span6{grid-column:1/-1}.sectionGrid,.grid2,.grid4,.activityTop{grid-template-columns:1fr}.accounts{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body><main>
<header>
  <div><div class="brand">AI CO-HOST</div><div class="sub">Sonnet 5 + OpenAI • 60 FPS preview • high-detail vision • $20 stream guard • up to 10 accounts</div></div>
  <div class="row"><div class="chips"><div class="chip" id="chipRealtime"><span class="dot"></span>AUDIO</div><div class="chip" id="chipVision"><span class="dot"></span>VISION</div><div class="chip" id="chipContext"><span class="dot"></span>CONTEXT</div></div><form method="post" action="/logout"><button class="small ghost" type="submit">Log out</button></form></div>
</header>

<section class="card span12">
  <div class="h">1 — Accounts & Stream</div>
  <div class="sectionGrid">
    <div>
      <div class="row"><div class="big">Co-host Accounts</div><button id="addAccount" class="small primary">+ Add Account</button><span id="accountLimit" class="status"></span></div>
      <div class="status">You can connect up to 10 accounts. One account is selected as the active sender at a time. Each slot can also have its own HTTP/HTTPS/SOCKS5 proxy.</div>
      <div id="accounts" class="accounts"></div>
    </div>
    <div>
      <div class="big" id="liveState">OFFLINE / UNKNOWN</div>
      <div class="label">Watched Kick username</div><input id="channelSlug" placeholder="streamer username">
      <div class="row" style="margin-top:7px"><button id="resolveChannel" class="primary">Resolve</button><button id="subscribeChat">Subscribe Chat</button></div>
      <div id="channelState" class="status"></div>
      <div id="streamMeta" class="status"></div>
      <div class="stats"><div class="stat"><b id="brainCalls">0</b><span>BRAIN CALLS</span></div><div class="stat"><b id="sentCount">0</b><span>SENT</span></div><div class="stat"><b id="chatCount">0</b><span>CHAT</span></div><div class="stat"><b id="ignoredChat">0</b><span>STALE IGNORED</span></div></div>
    </div>
  </div>
</section>

<section class="card span6">
  <div class="h">2 — Brain</div>
  <div class="grid2">
    <div><div class="label">Provider</div><select id="provider"><option value="anthropic">Claude Sonnet 5</option><option value="openai">OpenAI</option></select></div>
    <div><div class="label">Human Reaction</div><div class="rangeWrap"><input id="reaction" type="range" min="0" max="100" step="1"><div id="reactionPct" class="pct">10%</div></div></div>
    <div><div class="label">Per-stream budget</div><div class="rangeWrap"><input id="streamBudget" type="range" min="5" max="50" step="1"><div id="streamBudgetPct" class="pct">$20</div></div></div>
    <div><div class="label">Estimated cost</div><div id="costMeter" class="pct">$0.00 / $20</div><div id="costState" class="status">Normal vision</div></div>
  </div>
  <div class="label">Persona</div><textarea id="persona"></textarea>
  <div class="row"><label class="toggle"><input id="autoSend" type="checkbox"> Auto send</label><label class="toggle"><input id="viewerReplies" type="checkbox"> Viewer replies</label><button id="saveSettings" class="small primary">Save</button><button id="resetContext" class="small">Reset Context</button></div>
  <div id="brainSettingsState" class="status"></div>
</section>

<section class="card span6">
  <div class="h">3 — Live Watch</div>
  <div class="grid4">
    <div><div class="label">Preview FPS</div><select id="captureFps"><option value="30">30 FPS</option><option value="60">60 FPS</option></select></div>
    <div><div class="label">Vision FPS</div><select id="visionFps"><option value="1">1 FPS</option><option value="2">2 FPS</option><option value="4">4 FPS</option><option value="6">6 FPS</option><option value="8">8 FPS</option></select></div>
    <div><div class="label">Vision width</div><select id="visionWidth"><option value="720">720 px</option><option value="960">960 px</option><option value="1280">1280 px</option><option value="1600">1600 px</option></select></div>
    <div><div class="label">Frame burst</div><select id="visionBurstFrames"><option value="1">1 frame</option><option value="2">2 frames</option><option value="3">3 frames</option><option value="4">4 frames</option><option value="5">5 frames</option></select></div>
  </div>
  <div class="row" style="margin-top:8px"><button id="startWatch" class="primary">Start Stream Capture</button><button id="stopWatch" disabled>Stop</button></div>
  <div id="hearingState" class="status">Stopped</div>
  <video id="preview" class="preview" autoplay playsinline muted></video>
</section>

<section class="card span12">
  <div class="h">4 — Activity</div>
  <div class="activityTop">
    <div><div class="label">Latest heard</div><div id="latestHeard" class="reply">(nothing yet)</div></div>
    <div><div class="label">Latest reply</div><div id="latestReply" class="reply">(none)</div><div class="row" style="margin-top:6px"><input id="manualMessage" maxlength="500" placeholder="manual message"><button id="manualSend" class="small">Send</button></div><div id="replyState" class="status"></div></div>
    <div><div class="label">Latest brain decision</div><div id="brainDecision" class="feed mono">No decision yet.</div></div>
  </div>
  <div class="grid2"><div><div class="label">Current Stream Viewer Chat</div><div id="chatFeed" class="feed mono">Waiting for current-stream webhook events.</div></div><div><div class="label">System Log</div><div id="logFeed" class="feed mono">Starting...</div></div></div>
  <div id="contextState" class="status"></div>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
let captureStream=null,pc=null,dc=null,running=false,busy=false,visionFrames=[],frameTimer=null,frameAt=0;
const transcriptTurns=new Map();
let transcriptSeq=0,transcriptDrainTimer=null;
const TRANSCRIPT_REORDER_HOLD_MS=700,TRANSCRIPT_MAX_WAIT_MS=1800,TRANSCRIPT_MAX_AGE_MS=12000,TRANSCRIPT_MAX_TURNS=12;
async function jf(url,opt={}){const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opt.headers||{})},...opt});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d}
function on(id,v){$(id).classList.toggle("on",!!v)}
function ago(ms){if(!ms)return "never";const s=Math.max(0,Math.floor((Date.now()-ms)/1000));return s<60?s+"s ago":Math.floor(s/60)+"m ago"}
function fmtUptime(s){s=Number(s||0);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h?h+"h "+m+"m":m+"m"}
function esc(s){return String(s||"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]))}
function brainText(b){if(!b)return "No decision yet.";return ["provider: "+b.provider,"human reaction: "+b.score+"%","threshold: "+b.threshold+"%","decision: "+(b.shouldReply?"REPLY":"QUIET"),"reason: "+(b.reason||""),"reply: "+(b.reply||"(none)")].join("\n")}
function renderAccounts(k){const list=k.accounts||[];$("accountLimit").textContent=list.length+" / "+(k.maxAccounts||10);$("addAccount").disabled=list.length>=(k.maxAccounts||10);$("accounts").innerHTML=list.map(a=>'<div class="acct '+(a.active?'active':'')+'"><div class="acctTop"><div class="acctName">'+esc(a.connected?('@'+(a.username||a.label)):a.label)+'</div><div class="'+(a.connected?'ok':'warn')+'">'+(a.active?'ACTIVE':(a.connected?'CONNECTED':'EMPTY'))+'</div></div><div class="acctMeta">'+(a.connected?('user '+esc(a.userId||'?')):'Connect this slot with official OAuth')+'</div><div class="acctMeta">Proxy: '+esc(a.proxyConfigured?(a.proxyDisplay||'configured'):'direct')+'</div><div class="proxyRow"><input class="proxyInput" data-id="'+esc(a.id)+'" placeholder="http://user:pass@host:port or socks5://user:pass@host:port"><button class="small saveProxy" data-id="'+esc(a.id)+'">Save proxy</button><button class="small clearProxy" data-id="'+esc(a.id)+'">Clear</button></div><div class="acctBtns"><button class="small primary connectAcct" data-id="'+esc(a.id)+'">'+(a.connected?'Reconnect':'Connect')+'</button><button class="small useAcct" data-id="'+esc(a.id)+'">Use</button><button class="small disconnectAcct" data-id="'+esc(a.id)+'">Disconnect</button><button class="small danger deleteAcct" data-id="'+esc(a.id)+'">Remove</button></div></div>').join('')||'<div class="status">No account slots yet. Click + Add Account.</div>'}
function openKickOAuth(accountId){const w=760,h=780,left=Math.max(0,(screen.width-w)/2),top=Math.max(0,(screen.height-h)/2);const url='/auth/kick/start?accountId='+encodeURIComponent(accountId);const pop=window.open(url,'kick_oauth_'+accountId,'popup=yes,width='+w+',height='+h+',left='+left+',top='+top+',resizable=yes,scrollbars=yes');if(!pop)location.href=url}
function bindAccountButtons(){$("accounts").querySelectorAll(".connectAcct").forEach(b=>b.onclick=()=>openKickOAuth(b.dataset.id));$("accounts").querySelectorAll(".useAcct").forEach(b=>b.onclick=async()=>{await jf("/api/accounts/"+encodeURIComponent(b.dataset.id)+"/active",{method:"POST",body:"{}"});await loadStatus()});$("accounts").querySelectorAll(".disconnectAcct").forEach(b=>b.onclick=async()=>{await jf("/api/accounts/"+encodeURIComponent(b.dataset.id)+"/disconnect",{method:"POST",body:"{}"});await loadStatus()});$("accounts").querySelectorAll(".saveProxy").forEach(b=>b.onclick=async()=>{try{const input=b.closest('.acct').querySelector('.proxyInput');await jf("/api/accounts/"+encodeURIComponent(b.dataset.id)+"/proxy",{method:"POST",body:JSON.stringify({proxy:input.value.trim()})});input.value='';await loadStatus()}catch(e){alert(e.message)}});$("accounts").querySelectorAll(".clearProxy").forEach(b=>b.onclick=async()=>{await jf("/api/accounts/"+encodeURIComponent(b.dataset.id)+"/proxy",{method:"POST",body:JSON.stringify({proxy:''})});await loadStatus()});$("accounts").querySelectorAll(".deleteAcct").forEach(b=>b.onclick=async()=>{await jf("/api/accounts/"+encodeURIComponent(b.dataset.id),{method:"DELETE"});await loadStatus()})}
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.data?.type!=='kick-oauth-complete')return;if(e.data.ok)loadStatus()});
function render(d){const k=d.kick||{},rt=d.runtime||{},m=rt.metrics||{},ss=d.streamSession||{};renderAccounts(k);bindAccountButtons();if(!$('channelSlug').value)$('channelSlug').value=k.channelSlug||'';$('channelState').textContent=k.broadcasterId?'Broadcaster '+k.broadcasterId+' • webhook '+(k.subscription?.active?'active':'not active'):'Resolve the current streamer';$('liveState').textContent=ss.isLive?'LIVE':'OFFLINE / UNKNOWN';$('liveState').className='big '+(ss.isLive?'ok':'warn');$('streamMeta').textContent=ss.isLive?((ss.category||'Gaming')+' • '+(ss.title||'Untitled')+' • '+fmtUptime(ss.uptimeSeconds)):'No active live session reported';$('brainCalls').textContent=m.brainCalls||0;$('sentCount').textContent=m.sent||0;$('chatCount').textContent=m.chatEvents||0;$('ignoredChat').textContent=m.ignoredChatEvents||0;$('latestHeard').textContent=rt.lastHeard||'(nothing yet)';$('latestReply').textContent=rt.lastReply||'(none)';$('brainDecision').textContent=brainText(rt.lastBrain);$('contextState').textContent='Context '+ago(rt.latestContextAt)+' • vision '+ago(rt.latestFrameAt)+' • webhook '+ago(rt.lastWebhookAt)+' • active sender '+(k.activeUsername?('@'+k.activeUsername):'none');$('logFeed').textContent=(rt.logs||[]).join('\n')||'No logs yet';$('logFeed').scrollTop=$('logFeed').scrollHeight;$('chatFeed').textContent=(rt.recentChat||[]).map(x=>'['+new Date(x.createdAt||x.receivedAt).toLocaleTimeString()+'] '+x.username+': '+x.content).join('\n')||'Waiting for current-stream webhook events.';on('chipVision',running&&Date.now()-frameAt<2500);on('chipContext',Date.now()-(rt.latestContextAt||0)<60000);if(document.activeElement!==$('provider'))$('provider').value=d.settings.provider;if(document.activeElement!==$('reaction')){$('reaction').value=d.settings.humanReactionPercent;$('reactionPct').textContent=d.settings.humanReactionPercent+'%'}if(document.activeElement!==$('persona'))$('persona').value=d.settings.persona||'';$('autoSend').checked=!!d.settings.autoSend;$('viewerReplies').checked=!!d.settings.viewerReplies;$('captureFps').value=String(d.settings.captureFps||60);$('visionFps').value=String(d.settings.visionFps||6);$('visionWidth').value=String(d.settings.visionWidth||1280);$('visionBurstFrames').value=String(d.settings.visionBurstFrames||4);if(document.activeElement!==$('streamBudget')){$('streamBudget').value=String(d.settings.streamBudgetDollars||20);$('streamBudgetPct').textContent='$'+String(d.settings.streamBudgetDollars||20)}const c=rt.cost||{};$('costMeter').textContent='$'+Number(c.totalUsd||0).toFixed(2)+' / $'+Number(c.budget||d.settings.streamBudgetDollars||20).toFixed(0);$('costState').textContent=(c.throttle==='paused'?'Budget guard PAUSED auto brain':c.throttle==='heavy'?'Heavy vision throttle • 1 frame/call':c.throttle==='light'?'Light vision throttle • max 2 frames/call':'Normal vision')+' • brain $'+Number(c.brainUsd||0).toFixed(2)+' • hearing $'+Number(c.transcriptionUsd||0).toFixed(2);const ap=d.providers?.anthropic?.configured?'Sonnet 5 ready':'Sonnet 5 key missing';const op=d.providers?.openai?.configured?'OpenAI ready':'OpenAI key missing';$('brainSettingsState').textContent=ap+' • '+op}
async function loadStatus(){try{render(await jf('/api/status'))}catch(e){$('logFeed').textContent='Status error: '+e.message}}
$('addAccount').onclick=async()=>{try{await jf('/api/accounts/add',{method:'POST',body:'{}'});await loadStatus()}catch(e){$('accountLimit').textContent=e.message}};
$('reaction').oninput=()=>$('reactionPct').textContent=$('reaction').value+'%';
$('streamBudget').oninput=()=>$('streamBudgetPct').textContent='$'+$('streamBudget').value;
async function saveSettings(){try{await jf('/api/settings',{method:'POST',body:JSON.stringify({provider:$('provider').value,humanReactionPercent:Number($('reaction').value),autoSend:$('autoSend').checked,viewerReplies:$('viewerReplies').checked,persona:$('persona').value,captureFps:Number($('captureFps').value),visionFps:Number($('visionFps').value),visionWidth:Number($('visionWidth').value),visionBurstFrames:Number($('visionBurstFrames').value),streamBudgetDollars:Number($('streamBudget').value)})});$('brainSettingsState').textContent='Saved';await loadStatus()}catch(e){$('brainSettingsState').textContent=e.message}}
$('saveSettings').onclick=saveSettings;['reaction','provider','autoSend','viewerReplies','captureFps','visionFps','visionWidth','visionBurstFrames','streamBudget'].forEach(id=>$(id).onchange=saveSettings);
$('resolveChannel').onclick=async()=>{try{resetTranscriptPipeline();$('channelState').textContent='Resolving...';const d=await jf('/api/resolve-channel',{method:'POST',body:JSON.stringify({slug:$('channelSlug').value})});$('channelState').textContent='Broadcaster '+d.broadcasterId+' ready';await loadStatus()}catch(e){$('channelState').textContent=e.message}};
$('subscribeChat').onclick=async()=>{try{$('channelState').textContent='Subscribing...';const d=await jf('/api/chat/subscribe',{method:'POST',body:'{}'});$('channelState').textContent=d.existing?'Current channel already subscribed':'Current channel subscribed';await loadStatus()}catch(e){$('channelState').textContent=e.message}};
$('resetContext').onclick=async()=>{resetTranscriptPipeline();await jf('/api/context/reset',{method:'POST',body:'{}'});await loadStatus()};
$('manualSend').onclick=async()=>{try{const content=$('manualMessage').value.trim();if(!content)return;$('replyState').textContent='Sending...';await jf('/api/manual-send',{method:'POST',body:JSON.stringify({content})});$('manualMessage').value='';$('replyState').textContent='Sent';await loadStatus()}catch(e){$('replyState').textContent=e.message}};
function sampleFrame(){const v=$('preview');if(!running||!v.videoWidth||v.readyState<2)return;const target=Number($('visionWidth').value||1280),w=Math.min(target,v.videoWidth),h=Math.max(1,Math.round(v.videoHeight/v.videoWidth*w)),c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{alpha:false,desynchronized:true});ctx.drawImage(v,0,0,w,h);const dataUrl=c.toDataURL('image/jpeg',.80);visionFrames.push({dataUrl,at:Date.now()});if(visionFrames.length>5)visionFrames.splice(0,visionFrames.length-5);frameAt=Date.now();on('chipVision',true)}
function startFrameSampler(){clearInterval(frameTimer);sampleFrame();const fps=Math.max(1,Math.min(8,Number($('visionFps').value||6)));frameTimer=setInterval(sampleFrame,Math.round(1000/fps))}
function transcriptTurn(id){let key=String(id||'');if(key&&transcriptTurns.has(key))return transcriptTurns.get(key);const seq=++transcriptSeq;if(!key)key='fallback-'+seq;const turn={id:key,seq,createdAt:Date.now(),startMs:null,stopMs:null,delta:'',transcript:'',completedAt:0,processed:false};transcriptTurns.set(key,turn);return turn}
function turnOrder(t){return Number.isFinite(t.startMs)?t.startMs:(1e15+t.seq)}
function cleanupTranscriptTurns(){const now=Date.now(),items=[...transcriptTurns.values()].sort((a,b)=>turnOrder(a)-turnOrder(b));for(const t of items){if((t.processed&&now-(t.completedAt||now)>5000)||now-(t.completedAt||t.createdAt||now)>30000)transcriptTurns.delete(t.id)}const left=[...transcriptTurns.values()].sort((a,b)=>turnOrder(a)-turnOrder(b));while(left.length>TRANSCRIPT_MAX_TURNS){const t=left.shift();transcriptTurns.delete(t.id)}}
function resetTranscriptPipeline(){clearTimeout(transcriptDrainTimer);transcriptDrainTimer=null;transcriptTurns.clear();transcriptSeq=0;$('latestHeard').dataset.delta=''}
function scheduleBrainDrain(delay=TRANSCRIPT_REORDER_HOLD_MS){clearTimeout(transcriptDrainTimer);transcriptDrainTimer=setTimeout(()=>{transcriptDrainTimer=null;drainBrain()},delay)}
function handleRealtimeEvent(ev){const id=String(ev.item_id||ev.event_id||'');if(ev.type==='input_audio_buffer.speech_started'){const t=transcriptTurn(id);if(Number.isFinite(Number(ev.audio_start_ms)))t.startMs=Number(ev.audio_start_ms);t.delta='';$('latestHeard').dataset.delta='';$('hearingState').textContent='Realtime • speech detected';return}if(ev.type==='input_audio_buffer.speech_stopped'){const t=transcriptTurn(id);if(Number.isFinite(Number(ev.audio_end_ms)))t.stopMs=Number(ev.audio_end_ms);$('hearingState').textContent='Realtime • processing';return}if(ev.type==='conversation.item.input_audio_transcription.delta'){const t=transcriptTurn(id);t.delta+=(ev.delta||'');$('latestHeard').textContent=t.delta;$('latestHeard').dataset.delta=t.delta;return}if(ev.type==='conversation.item.input_audio_transcription.completed'){const t=transcriptTurn(id),text=String(ev.transcript||'').replace(/\s+/g,' ').trim();t.delta='';t.transcript=text;t.completedAt=Date.now();$('latestHeard').dataset.delta='';if(text){$('latestHeard').textContent=text;scheduleBrainDrain()}cleanupTranscriptTurns();return}if(ev.type==='conversation.item.input_audio_transcription.failed'){$('hearingState').textContent='Transcription failed: '+JSON.stringify(ev.error||ev);return}if(ev.type==='error')$('hearingState').textContent='Realtime error: '+JSON.stringify(ev.error||ev)}
async function drainBrain(){if(busy)return;cleanupTranscriptTurns();const now=Date.now(),ordered=[...transcriptTurns.values()].filter(t=>!t.processed).sort((a,b)=>turnOrder(a)-turnOrder(b)),completed=ordered.filter(t=>t.transcript&&t.completedAt);if(!completed.length)return;const firstCompleted=completed[0],blocking=ordered.find(t=>!t.transcript&&turnOrder(t)<turnOrder(firstCompleted));if(blocking&&now-firstCompleted.completedAt<TRANSCRIPT_MAX_WAIT_MS){scheduleBrainDrain(250);return}const ready=completed.filter(t=>now-t.completedAt<=TRANSCRIPT_MAX_AGE_MS);for(const t of completed)if(!ready.includes(t))t.processed=true;if(!ready.length){cleanupTranscriptTurns();return}const batch=ready.slice(-4);for(const t of ready)t.processed=true;const text=batch.map(t=>t.transcript).join(' ').replace(/\s+/g,' ').trim().slice(-1800);if(!text){cleanupTranscriptTurns();return}busy=true;$('hearingState').textContent='Realtime • brain using latest '+batch.length+' turn'+(batch.length===1?'':'s');try{const burst=Math.max(1,Math.min(5,Number($('visionBurstFrames').value||4))),frames=visionFrames.slice(-burst).map(x=>x.dataUrl);const d=await jf('/api/brain',{method:'POST',body:JSON.stringify({transcript:text,frameDataUrls:frames})});$('brainDecision').textContent=brainText(d);if(d.action==='sent')$('replyState').textContent='Sent: '+d.reply;else if(d.action==='preview')$('replyState').textContent='Preview: '+d.reply;else $('replyState').textContent='Quiet: '+(d.reason||'');await loadStatus()}catch(e){$('replyState').textContent='Brain error: '+e.message}finally{busy=false;cleanupTranscriptTurns();if([...transcriptTurns.values()].some(t=>!t.processed&&t.transcript))scheduleBrainDrain(100)}}
async function connectRealtime(){const token=await jf('/api/realtime-token',{method:'POST',body:'{}'}),key=token.value;if(!key)throw new Error('Realtime client secret missing value');pc=new RTCPeerConnection();pc.onconnectionstatechange=()=>{const s=pc?.connectionState||'closed';on('chipRealtime',s==='connected');if(s==='connected')$('hearingState').textContent='Realtime hearing connected';else if(['failed','disconnected','closed'].includes(s)&&running)$('hearingState').textContent='Realtime '+s};const track=captureStream.getAudioTracks()[0];if(!track)throw new Error('Share tab audio when starting capture');pc.addTrack(track,new MediaStream([track]));dc=pc.createDataChannel('oai-events');dc.onmessage=e=>{try{handleRealtimeEvent(JSON.parse(e.data))}catch{}};const offer=await pc.createOffer();await pc.setLocalDescription(offer);const r=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',body:offer.sdp,headers:{Authorization:'Bearer '+key,'Content-Type':'application/sdp'}});if(!r.ok)throw new Error('Realtime WebRTC failed '+r.status+': '+await r.text());await pc.setRemoteDescription({type:'answer',sdp:await r.text()})}
$('startWatch').onclick=async()=>{if(running)return;try{resetTranscriptPipeline();await saveSettings();await jf('/api/cost/reset',{method:'POST',body:'{}'});const fps=Number($('captureFps').value||60);captureStream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:fps,max:fps},width:{ideal:1920},height:{ideal:1080},cursor:'never'},audio:true});if(!captureStream.getAudioTracks().length)throw new Error('No shared audio. Choose a browser tab and enable Share tab audio.');$('preview').srcObject=captureStream;await $('preview').play();running=true;$('startWatch').disabled=true;$('stopWatch').disabled=false;captureStream.getTracks().forEach(t=>t.addEventListener('ended',stopWatch));startFrameSampler();const vs=captureStream.getVideoTracks()[0]?.getSettings?.()||{};$('hearingState').textContent='Preview '+Math.round(vs.frameRate||fps)+' FPS • vision '+$('visionFps').value+' FPS at '+$('visionWidth').value+'px • connecting audio...';await connectRealtime()}catch(e){$('hearingState').textContent=e.message;stopWatch()}};
function stopWatch(){running=false;resetTranscriptPipeline();fetch('/api/watch/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});clearInterval(frameTimer);frameTimer=null;visionFrames=[];try{dc?.close()}catch{}try{pc?.close()}catch{}try{captureStream?.getTracks().forEach(t=>t.stop())}catch{}dc=null;pc=null;captureStream=null;$('preview').srcObject=null;$('startWatch').disabled=false;$('stopWatch').disabled=true;$('hearingState').textContent='Stopped';on('chipRealtime',false);on('chipVision',false)}
$('stopWatch').onclick=stopWatch;
loadStatus();setInterval(loadStatus,3000);setInterval(()=>on('chipVision',running&&Date.now()-frameAt<2500),1000);
</script>
</body></html>`;

app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("AI Co-host rework 2.2 auth + ordered realtime transcript pipeline running on port " + PORT);
  console.log("Brain providers: Sonnet 5=" + (ANTHROPIC_API_KEY ? "configured" : "missing key") + " • OpenAI=" + (OPENAI_API_KEY ? "configured" : "missing key"));
});

setInterval(() => queryStreamSession().catch(() => {}), 60000).unref();
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));