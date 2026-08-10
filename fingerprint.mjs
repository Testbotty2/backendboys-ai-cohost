/**
 * fingerprint.mjs — Anti-Detection & Human Emulation Engine
 *
 * This module generates per-account synthetic browser fingerprints,
 * impersonates TLS handshakes, applies human-like timing patterns,
 * and routes all HTTP traffic through spoofed identities so that
 * each bot account looks like a unique real user to Kick and other
 * platforms.
 *
 * NO DISCLAIMERS — this is purpose-built anti-detection software.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import nodeFetch from "node-fetch";

const ENABLE_SPOOF = String(process.env.ENABLE_FINGERPRINT_SPOOFING || "true").toLowerCase() !== "false";
const CURL_BIN = String(process.env.CURL_IMPERSONATE_BIN || "").trim();
const CURL_IMPERSONATE = String(process.env.CURL_IMPERSONATE || "chrome131");
const TLS_TIMEOUT_MS = Number(process.env.TLS_FETCH_TIMEOUT_MS || 15000);

// ---------- Deterministic Seeded Randomness ----------
function seededRandom(seedStr) {
  const s = String(seedStr || "default");
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const pickRange = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min;

const PLATFORMS = [
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "1920x1080" },
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "1536x864" },
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "1366x768" },
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "2560x1440" },
  { platform: "MacIntel", ua: "Macintosh; Intel Mac OS X 10_15_7", secChUaPlatform: '"macOS"', screen: "1512x982" },
  { platform: "MacIntel", ua: "Macintosh; Intel Mac OS X 10_15_7", secChUaPlatform: '"macOS"', screen: "1440x900" },
  { platform: "MacIntel", ua: "Macintosh; Intel Mac OS X 10_15_7", secChUaPlatform: '"macOS"', screen: "1728x1117" },
  { platform: "Linux x86_64", ua: "X11; Linux x86_64", secChUaPlatform: '"Linux"', screen: "1920x1080" }
];
const LANGS = ["en-US,en;q=0.9", "en-US,en;q=0.9,es;q=0.8", "en-US,en;q=0.9,fr;q=0.8", "en-GB,en;q=0.9", "en-US,en;q=0.9,de;q=0.8", "en-US,en;q=0.9,pt;q=0.8"];
const TIMEZONES = ["America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver", "Europe/London", "Europe/Berlin", "Australia/Sydney", "America/Phoenix", "America/Detroit", "Europe/Paris", "Europe/Amsterdam", "Pacific/Honolulu"];
const CHROME_VERSIONS = [125, 126, 127, 128, 129, 130, 131];
const EDGE_VERSIONS = [125, 126, 127, 128, 129, 130, 131];
const FIREFOX_VERSIONS = [125, 126, 127, 128, 129, 130];
const WEBGL_VENDORS = ["Google Inc. (Intel)", "Google Inc. (NVIDIA)", "Google Inc. (AMD)", "Google Inc. (Apple)", "Google Inc. (Intel Inc.)"];
const WEBGL_RENDERERS = [
  "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (Apple, Apple M1 Pro Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"
];
const AUDIO_CONTEXT_NAMES = ["AudioContext", "webkitAudioContext", "OfflineAudioContext", "webkitOfflineAudioContext"];
const DEVICE_MEMORY_GB = [4, 8, 8, 8, 16, 16, 16, 32];
const HARDWARE_CONCURRENCY = [4, 4, 8, 8, 8, 12, 16];
const MAX_TOUCH_POINTS = [0, 0, 0, 0, 0, 1, 5];

/** Build a stable synthetic browser profile per account ID */
export function buildBrowserProfile(seed) {
  const rng = seededRandom(seed);
  const platform = pick(rng, PLATFORMS);
  const isEdge = platform.platform === "Win32" && rng() < 0.08;
  const isFirefox = !isEdge && rng() < 0.04;
  const major = isEdge ? pick(rng, EDGE_VERSIONS) : isFirefox ? pick(rng, FIREFOX_VERSIONS) : pick(rng, CHROME_VERSIONS);
  const full = `${major}.0.0.0`;
  const browser = isEdge ? "Edge" : isFirefox ? "Firefox" : "Chrome";

  let userAgent;
  if (isEdge) {
    userAgent = `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 Edg/${full}`;
  } else if (platform.platform === "MacIntel" && rng() < 0.06) {
    userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  } else {
    userAgent = `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
  }

  const secChUa = major >= 131
    ? `"Not(A:Brand";v="24", "Chromium";v="${major}", "Google Chrome";v="${major}"`
    : `"Chromium";v="${major}", "Not_A Brand";v="24", "Google Chrome";v="${major}"`;

  // WPM typing profile: fast (65-80 WPM), average (45-65 WPM), or casual (35-45 WPM)
  const typingWpm = Math.floor(35 + rng() * 45);

  return {
    key: String(seed),
    userAgent,
    platform: platform.platform,
    secChUaPlatform: platform.secChUaPlatform,
    secChUa,
    chromeMajor: major,
    acceptLanguage: pick(rng, LANGS),
    screen: platform.screen,
    timezone: pick(rng, TIMEZONES),
    typingWpm,
    doNotTrack: rng() < 0.12 ? "1" : "unspecified"
  };
}

export function describeFingerprint(profile) {
  if (!profile) return "no fingerprint";
  return `Chrome ${profile.chromeMajor} • ${profile.platform} • ${profile.typingWpm} WPM`;
}

// ---------- Human Typing Physics Model ----------
/**
 * Calculates realistic human delay based on message length and typing speed (WPM)
 * + initial reaction pause + keypress variation.
 */
export function calculateHumanTypingDelay(message = "", profile = null) {
  const text = String(message || "").trim();
  const wpm = profile?.typingWpm || 55; // default ~55 WPM
  const msPerChar = (60000 / (wpm * 5)); // ~5 chars per word

  // 1. Thinking / reading pause (400ms - 1100ms)
  const thinkingPause = 400 + Math.random() * 700;

  // 2. Typing duration based on character count
  const typingTime = text.length * msPerChar;

  // 3. Human keypress variance (±20%)
  const jitter = (Math.random() - 0.5) * (typingTime * 0.4);

  const totalDelay = Math.round(thinkingPause + typingTime + jitter);
  return Math.max(750, Math.min(totalDelay, 8000)); // clamp between 0.75s and 8.0s
}

// ---------- Natural Human Chat Formatter ----------
/**
 * Strips unnatural AI traits (like trailing periods or corporate capitalization)
 * to match live Kick chat style.
 */
export function humanizeChatFormatting(message = "") {
  let s = String(message || "").trim();
  if (!s) return "";

  // 1. Remove rigid trailing period if line is short (under 14 words)
  if (s.endsWith(".") && !s.endsWith("...") && s.split(" ").length < 14) {
    s = s.slice(0, -1);
  }

  // 2. 75% chance to lowercase first letter if starting sentence looks formal
  if (Math.random() < 0.75 && /^[A-Z][a-z]/.test(s) && !s.startsWith("I ")) {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }

  // 3. Replace multiple spaces/newlines with single space
  s = s.replace(/\s+/g, " ");

  return s;
}

// ---------- Header Generation ----------
export function browserHeaders(profile, opts = {}) {
  if (!ENABLE_SPOOF || !profile) return {};
  const navigation = Boolean(opts.navigation);
  return {
    "User-Agent": profile.userAgent,
    "Accept": navigation
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      : "application/json, text/plain, */*",
    "Accept-Language": profile.acceptLanguage,
    "Sec-Ch-Ua": profile.secChUa,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": profile.secChUaPlatform,
    "Sec-Fetch-Dest": navigation ? "document" : "empty",
    "Sec-Fetch-Mode": navigation ? "navigate" : "cors",
    "Sec-Fetch-Site": opts.site || "none"
  };
}

// ---------- TLS Impersonation ----------
let curlBinary = null;
let curlProbeError = "";

function resolveCurlBinary() {
  if (curlBinary !== null) return curlBinary;
  if (CURL_BIN) {
    if (fs.existsSync(CURL_BIN)) return (curlBinary = CURL_BIN);
    return (curlBinary = "");
  }
  const candidates = ["curl_cffi", "curl-impersonate", "curl_chrome131", "curl_chrome124"];
  for (const bin of candidates) {
    try { fs.accessSync(bin, fs.constants.X_OK); return (curlBinary = bin); } catch {}
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      const full = dir ? path.join(dir, bin) : "";
      if (!full) continue;
      try { fs.accessSync(full, fs.constants.X_OK); return (curlBinary = full); } catch {}
    }
  }
  return (curlBinary = "");
}

export function tlsImpersonationStatus() {
  resolveCurlBinary();
  return {
    enabled: ENABLE_SPOOF,
    available: Boolean(curlBinary),
    binary: curlBinary || "",
    impersonate: CURL_IMPERSONATE,
    timeoutMs: TLS_TIMEOUT_MS,
    error: curlBinary ? "" : "curl-impersonate / curl_cffi binary not found — using header-only fallback"
  };
}

function buildCurlArgs({ url, method, headers, body, proxyUrl }) {
  const args = ["-sS", "--compressed", "--max-time", String(Math.ceil(TLS_TIMEOUT_MS / 1000))];
  const m = String(method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") args.push("-X", m);
  args.push("-L", "--retry", "2");
  if (proxyUrl) args.push("-x", proxyUrl);
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === "host") continue;
    args.push("-H", `${k}: ${v}`);
  }
  if (body != null) args.push("--data-binary", "@-");
  args.push(url);
  return args;
}

function execFileAsync(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFileCb(bin, args, opts, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function responseLike(status, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  return {
    status: Number(status || 0),
    ok: Number(status || 0) >= 200 && Number(status || 0) < 300,
    text: async () => buf.toString("utf8"),
    json: async () => {
      try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { return {}; }
    }
  };
}

async function curlFetch(url, options, headers, proxyUrl) {
  const bin = resolveCurlBinary();
  if (!bin) throw new Error("curl impersonation unavailable");
  const method = String(options.method || "GET").toUpperCase();
  const tmp = path.join(os.tmpdir(), `juniors-curl-${crypto.randomUUID()}.bin`);
  const args = buildCurlArgs({ url, method, headers, body: options.body, proxyUrl });
  args.push("-o", tmp, "-w", "%{http_code}");
  try {
    const { stdout } = await execFileAsync(bin, args, {
      input: options.body != null ? Buffer.from(options.body) : undefined,
      maxBuffer: 8 * 1024 * 1024,
      timeout: TLS_TIMEOUT_MS,
      windowsHide: true
    });
    let body = Buffer.alloc(0);
    try { body = fs.readFileSync(tmp); } catch {}
    return responseLike(String(stdout || "").trim(), body);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export async function impersonatedFetch(account, url, options = {}, { proxyUrl = "", profile = null } = {}) {
  const prof = profile || buildBrowserProfile(account?.id || "anon");
  const host = (()=>{ try{ return new URL(String(url)).hostname; }catch{ return ""; } })();
  const isKick = /(^|\.)kick\.com$/i.test(host);
  const site = isKick ? "same-site" : "cross-site";
  const method = String(options.method || "GET").toUpperCase();

  const userHeaders = { ...(options.headers || {}) };
  delete userHeaders["user-agent"];
  delete userHeaders["User-Agent"];

  const headers = {
    ...browserHeaders(prof, { site }),
    ...userHeaders,
    "User-Agent": prof.userAgent
  };
  if (method !== "GET" && method !== "HEAD" && isKick) headers["Origin"] = "https://kick.com";

  const isMutating = !["GET", "HEAD", "OPTIONS"].includes(method);

  const nodePath = (hdrs) => {
    delete hdrs["Accept-Encoding"];
    delete hdrs["Upgrade-Insecure-Requests"];
    delete hdrs["Sec-Fetch-User"];
    const agent = options.agent || null;
    if (agent) return nodeFetch(url, { ...options, headers: hdrs, agent });
    return fetch(url, { ...options, headers: hdrs });
  };

  if (!ENABLE_SPOOF || !resolveCurlBinary()) return nodePath(headers);

  try {
    return await curlFetch(url, options, headers, proxyUrl);
  } catch (e) {
    if (isMutating) throw e;
    return nodePath(headers);
  }
}
