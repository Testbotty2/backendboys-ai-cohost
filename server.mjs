import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3210);
const TOKEN_FILE = path.join(__dirname, ".kick-token.json");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.KICK_REDIRECT_URI || `http://localhost:${PORT}/auth/kick/callback`;
const CHANNEL_SLUG = process.env.KICK_CHANNEL_SLUG || "";
const BOT_NAME = process.env.BOT_NAME || "KickAI";
const STREAMER_NAME = process.env.STREAMER_NAME || "Streamer";
const AUTO_SEND = String(process.env.AUTO_SEND || "false").toLowerCase() === "true";
const DECISION_MODEL = process.env.OPENAI_DECISION_MODEL || "gpt-4.1-mini";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

let oauthState = null;
let broadcasterId = process.env.KICK_BROADCASTER_USER_ID || "";
let lastSent = 0;
const history = [];
const MAX_HISTORY = 60;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); }
  catch { return null; }
}
function saveToken(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}
function normalize(s) {
  return String(s || "").toLowerCase()
    .replace(/@[a-z0-9_]+/gi, "@user")
    .replace(/[^a-z0-9@\s]/gi, " ")
    .replace(/\s+/g, " ").trim();
}
function similarity(a, b) {
  const A = new Set(normalize(a).split(" ").filter(Boolean));
  const B = new Set(normalize(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / new Set([...A, ...B]).size;
}
function isRepeat(candidate) {
  const c = normalize(candidate);
  return history.some(old => {
    const o = normalize(old);
    return c === o ||
      (c.length >= 8 && o.length >= 8 && (c.includes(o) || o.includes(c))) ||
      similarity(candidate, old) >= 0.72;
  });
}

async function token() {
  let t = loadToken();
  if (!t?.access_token) throw new Error("Kick account not authorized.");
  if (!t.expires_at || Date.now() < t.expires_at - 60000) return t;
  if (!t.refresh_token) throw new Error("Kick token expired. Re-authorize.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  const r = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Kick refresh failed: ${JSON.stringify(data)}`);
  t = {...data, expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null};
  saveToken(t);
  return t;
}

app.get("/auth/kick/start", (_req, res) => {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  oauthState = { verifier, state, created: Date.now() };

  const qs = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "user:read channel:read chat:write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  res.redirect(`https://id.kick.com/oauth/authorize?${qs}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  try {
    if (!oauthState || req.query.state !== oauthState.state) throw new Error("OAuth state mismatch.");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(req.query.code || ""),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: oauthState.verifier
    });
    const r = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    saveToken({...data, expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null});
    oauthState = null;
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`<pre>${e.message}</pre>`);
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    kickAuthorized: Boolean(loadToken()?.access_token),
    broadcasterId: broadcasterId || null,
    channelSlug: CHANNEL_SLUG,
    botName: BOT_NAME,
    streamerName: STREAMER_NAME,
    autoSend: AUTO_SEND
  });
});

app.use(express.json({limit: "9mb"}));

app.post("/api/resolve-channel", async (req, res) => {
  try {
    const t = await token();
    const slug = String(req.body?.slug || CHANNEL_SLUG).trim();
    const r = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
      headers: {Authorization: `Bearer ${t.access_token}`, Accept: "application/json"}
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    const item = Array.isArray(data?.data) ? data.data[0] : data?.data;
    broadcasterId = String(
      item?.broadcaster_user_id ?? item?.user_id ?? item?.broadcaster?.user_id ?? ""
    );
    if (!broadcasterId) throw new Error("Could not resolve broadcaster_user_id.");
    res.json({ok: true, broadcasterId});
  } catch (e) {
    res.status(500).json({ok: false, error: e.message});
  }
});

async function sendKick(content) {
  const t = await token();
  if (!broadcasterId) throw new Error("Resolve the broadcaster ID first.");
  const r = await fetch("https://api.kick.com/public/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      broadcaster_user_id: Number(broadcasterId),
      content,
      type: "user"
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kick send failed: ${JSON.stringify(data)}`);
  return data;
}

app.post("/api/test", async (req, res) => {
  try {
    await sendKick(String(req.body?.content || "AI co-host test ✅").slice(0, 450));
    res.json({ok: true});
  } catch (e) {
    res.status(500).json({ok: false, error: e.message});
  }
});

// raw audio route must be defined with its own parser
app.post("/api/transcribe",
  express.raw({type: ["audio/*","video/webm","application/octet-stream"], limit: "25mb"}),
  async (req, res) => {
    let tmp = null;
    try {
      if (!req.body?.length) return res.json({text: ""});
      tmp = path.join(os.tmpdir(), `kick-ai-${crypto.randomUUID()}.webm`);
      fs.writeFileSync(tmp, Buffer.from(req.body));
      const tx = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: TRANSCRIBE_MODEL
      });
      res.json({text: String(tx.text || "").trim()});
    } catch (e) {
      res.status(500).json({text: "", error: e.message});
    } finally {
      if (tmp) try { fs.unlinkSync(tmp); } catch {}
    }
  }
);

app.post("/api/decide", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const recent = String(req.body?.recentTranscript || "").trim();
    const frame = String(req.body?.frameDataUrl || "");
    if (!transcript) return res.json({action: "skip", reason: "no speech"});
    if (Date.now() - lastSent < 12000) return res.json({action: "skip", reason: "cooldown"});

    const content = [{
      type: "input_text",
      text: `You are ${BOT_NAME}, a clearly identified AI co-host for ${STREAMER_NAME}'s Kick stream.

Current speech:
${transcript}

Recent speech:
${recent || "(none)"}

Recent AI replies:
${history.slice(-15).join("\n") || "(none)"}

Reply mainly to ${STREAMER_NAME}, based on what they say and what is visible on stream.
Stay quiet if there is no useful moment. Output exactly SKIP when quiet.
Keep replies 2-12 words, one short sentence max.
Use casual gaming-stream chat style.
Light slang like bruh, gang, my boy, ngl, lowkey, fr, cooked, sold, locked in is okay occasionally, not every message.
Do not pretend to be a human viewer or claim human experiences.
Do not repeat or lightly reword recent replies.
Return only the chat message or exactly SKIP.`
    }];

    if (frame.startsWith("data:image/")) {
      content.push({type: "input_image", image_url: frame, detail: "low"});
    }

    const out = await openai.responses.create({
      model: DECISION_MODEL,
      input: [{role: "user", content}]
    });

    const reply = String(out.output_text || "").replace(/\s+/g, " ").trim().slice(0, 450);
    if (!reply || reply.toUpperCase() === "SKIP") return res.json({action:"skip", reason:"model"});
    if (isRepeat(reply)) return res.json({action:"skip", reason:"repeat"});

    if (!AUTO_SEND) return res.json({action:"preview", reply});

    await sendKick(reply);
    lastSent = Date.now();
    history.push(reply);
    while (history.length > MAX_HISTORY) history.shift();
    res.json({action:"sent", reply});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post("/api/send-preview", async (req, res) => {
  try {
    const reply = String(req.body?.reply || "").trim().slice(0,450);
    if (!reply) throw new Error("No reply supplied.");
    if (isRepeat(reply)) throw new Error("Anti-repeat blocked this message.");
    await sendKick(reply);
    lastSent = Date.now();
    history.push(reply);
    while (history.length > MAX_HISTORY) history.shift();
    res.json({ok:true});
  } catch (e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Kick AI dashboard: http://localhost:${PORT}`);
});
