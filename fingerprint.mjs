/**
 * fingerprint.mjs — anti-detection / anti-fingerprint layer (v10.4 Optimized)
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

const PLATFORMS = [
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "1920x1080" },
  { platform: "Win32", ua: "Windows NT 10.0; Win64; x64", secChUaPlatform: '"Windows"', screen: "1536x864" },
  { platform: "MacIntel", ua: "Macintosh; Intel Mac OS X 10_15_7", secChUaPlatform: '"macOS"', screen: "1512x982" },
  { platform: "MacIntel", ua: "Macintosh; Intel Mac OS X 10_15_7", secChUaPlatform: '"macOS"', screen: "1440x900" },
  { platform: "Linux x86_64", ua: "X11; Linux x86_64", secChUaPlatform: '"Linux"', screen: "1920x1080" }
];
const LANGS = ["en-US,en;q=0.9", "en-US,en;q=0.9,es;q=0.8", "en-US,en;q=0.9,fr;q=0.8", "en-GB,en;q=0.9"];
const TIMEZONES = ["America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver", "Europe/London", "Europe/Berlin", "Australia/Sydney"];
const CHROME_VERSIONS = [124, 125, 126, 127, 128, 129, 130, 131];

export function buildBrowserProfile(seed) {
  const rng = seededRandom(seed);
  const platform = pick(rng, PLATFORMS);
  const major = pick(rng, CHROME_VERSIONS);
  const full = `${major}.0.0.0`;
  const isEdge = platform.platform === "Win32" && rng() < 0.08;

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
    : major >= 129
      ? `"Chromium";v="${major}", "Not_A Brand";v="24", "Google Chrome";v="${major}"`
      : `"Not_A Brand";v="24", "Chromium";v="${major}", "Google Chrome";v="${major}"`;

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
    doNotTrack: rng() < 0.12 ? "1" : "unspecified"
  };
}

export function describeFingerprint(profile) {
  if (!profile) return "no fingerprint";
  return `Chrome ${profile.chromeMajor} • ${profile.platform} • ${String(profile.acceptLanguage || "").split(",")[0]}`;
}

export function browserHeaders(profile, opts = {}) {
  if (!ENABLE_SPOOF || !profile) return {};
  const navigation = Boolean(opts.navigation);
  const h = {
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
  if (navigation) {
    h["Sec-Fetch-User"] = "?1";
    h["Upgrade-Insecure-Requests"] = "1";
  }
  return h;
}

let curlBinary = null;
let curlProbeError = "";

function resolveCurlBinary() {
  if (curlBinary !== null) return curlBinary;
  if (CURL_BIN) {
    if (fs.existsSync(CURL_BIN)) return (curlBinary = CURL_BIN);
    curlProbeError = `CURL_IMPERSONATE_BIN not found: ${CURL_BIN}`;
    return (curlBinary = "");
  }
  const candidates = ["curl_cffi", "curl-impersonate", "curl_chrome131", "curl_chrome124", "curl_chrome116"];
  for (const bin of candidates) {
    try { fs.accessSync(bin, fs.constants.X_OK); return (curlBinary = bin); } catch {}
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      const full = dir ? path.join(dir, bin) : "";
      if (!full) continue;
      try { fs.accessSync(full, fs.constants.X_OK); return (curlBinary = full); } catch {}
    }
  }
  curlProbeError = "curl-impersonate / curl_cffi binary not found — using Node fetch fallback with spoofed headers";
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
    error: curlBinary ? "" : curlProbeError
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
    statusText: "",
    headers: {},
    text: async () => buf.toString("utf8"),
    json: async () => {
      try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { return {}; }
    },
    arrayBuffer: async () => buf
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

function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return ""; }
}

export async function impersonatedFetch(account, url, options = {}, { proxyUrl = "", profile = null } = {}) {
  const prof = profile || buildBrowserProfile(account?.id || "anon");
  const host = hostOf(url);
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
