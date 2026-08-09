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

const PORT = Number(process.env.PORT || 10000);
const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.KICK_REDIRECT_URI || "";
const CHANNEL_SLUG = process.env.KICK_CHANNEL_SLUG || "";
const BOT_NAME = process.env.BOT_NAME || "AI Co-host";
const STREAMER_NAME = process.env.STREAMER_NAME || "Streamer";
const AUTO_SEND = String(process.env.AUTO_SEND || "true").toLowerCase() === "true";
const DECISION_MODEL = process.env.OPENAI_DECISION_MODEL || "gpt-4.1-mini";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 35000);

const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

if (!SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set. Kick OAuth persistence will not work securely.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const DASHBOARD_HTML = "<!doctype html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <title>Backendboys AI Co-host</title>\n  <style>\nbody{font-family:Arial,sans-serif;background:#0b0b0c;color:#f5f5f5;margin:0}\nmain{max-width:900px;margin:30px auto;padding:0 18px}\nsection{background:#151518;border:1px solid #303036;border-radius:14px;padding:18px;margin:14px 0}\ninput{width:100%;box-sizing:border-box;padding:11px;margin:8px 0;background:#0e0e10;color:#fff;border:1px solid #3a3a40;border-radius:9px}\nbutton,.btn{display:inline-block;padding:10px 13px;margin:5px 6px 5px 0;border-radius:9px;border:1px solid #444;background:#242428;color:white;text-decoration:none;cursor:pointer}\nvideo{width:100%;max-height:360px;background:black;margin-top:12px;border-radius:10px}\n#reply{font-size:20px;padding:14px;background:#0e0e10;border-radius:10px;margin:10px 0}\npre{white-space:pre-wrap;background:#111;padding:12px;border-radius:10px;color:#a9dda9}\n</style>\n</head>\n<body>\n<main>\n  <h1>Backendboys AI Co-host</h1>\n  <p>Cloud mode \u2022 No OBS \u2022 No Tampermonkey.</p>\n\n  <section>\n    <h2>1. Kick OAuth</h2>\n    <a class=\"btn\" href=\"/auth/kick/start\">Authorize AI Kick account</a>\n    <div id=\"kick\"></div>\n  </section>\n\n  <section>\n    <h2>2. Stream channel</h2>\n    <input id=\"slug\" placeholder=\"Your channel name\">\n    <button id=\"resolve\">Resolve broadcaster ID</button>\n    <div id=\"channel\"></div>\n  </section>\n\n  <section>\n    <h2>3. Test official chat posting</h2>\n    <input id=\"testText\" value=\"AI co-host connection test \u2705\">\n    <button id=\"test\">Send test message</button>\n    <div id=\"testStatus\"></div>\n  </section>\n\n  <section>\n    <h2>4. Watch stream</h2>\n    <p>Open your live Kick stream in another tab. Click Start, choose that Kick tab, and enable <b>Share tab audio</b>.</p>\n    <button id=\"start\">Start stream watch</button>\n    <button id=\"stop\" disabled>Stop</button>\n    <div id=\"watch\">Stopped</div>\n    <div><b>Latest heard:</b> <span id=\"heard\">(nothing yet)</span></div>\n    <video id=\"preview\" muted playsinline></video>\n  </section>\n\n  <section>\n    <h2>5. AI reply</h2>\n    <div id=\"mode\"></div>\n    <div id=\"reply\">(waiting)</div>\n    <button id=\"sendPreview\" disabled>Send preview to Kick</button>\n    <div id=\"replyStatus\"></div>\n  </section>\n\n  <pre id=\"log\"></pre>\n</main>\n<script>\nconst $ = id => document.getElementById(id);\nlet statusInfo, stream, recorder, running=false, busy=false, recent=[], pending=\"\";\n\nfunction log(s){ $(\"log\").textContent = `[${new Date().toLocaleTimeString()}] ${s}\\n` + $(\"log\").textContent; }\nasync function j(url, options={}){\n  const r = await fetch(url,{...options,headers:{...(options.body && !(options.body instanceof Blob)?{\"Content-Type\":\"application/json\"}:{}),...(options.headers||{})}});\n  const d = await r.json().catch(()=>({}));\n  if(!r.ok) throw new Error(d.error||r.statusText);\n  return d;\n}\nasync function load(){\n  statusInfo=await j(\"/api/status\");\n  $(\"kick\").textContent=statusInfo.kickAuthorized?\"Kick authorized \u2705\":\"Kick not authorized\";\n  $(\"slug\").value=statusInfo.channelSlug||\"\";\n  $(\"channel\").textContent=statusInfo.broadcasterId?`Broadcaster ID: ${statusInfo.broadcasterId}`:\"Not resolved\";\n  $(\"mode\").textContent=statusInfo.autoSend?\"AUTO_SEND=true\":\"AUTO_SEND=false \u2014 preview first\";\n}\n$(\"resolve\").onclick=async()=>{\n  try{\n    const d=await j(\"/api/resolve-channel\",{method:\"POST\",body:JSON.stringify({slug:$(\"slug\").value})});\n    $(\"channel\").textContent=`Broadcaster ID: ${d.broadcasterId} \u2705`;\n  }catch(e){$(\"channel\").textContent=e.message}\n};\n$(\"test\").onclick=async()=>{\n  try{\n    await j(\"/api/test\",{method:\"POST\",body:JSON.stringify({content:$(\"testText\").value})});\n    $(\"testStatus\").textContent=\"Sent \u2705\";\n  }catch(e){$(\"testStatus\").textContent=e.message}\n};\nfunction frame(){\n  const v=$(\"preview\");\n  if(v.readyState<2) return \"\";\n  const c=document.createElement(\"canvas\"), w=Math.min(640,v.videoWidth), h=Math.round(v.videoHeight/v.videoWidth*w);\n  c.width=w;c.height=h;c.getContext(\"2d\").drawImage(v,0,0,w,h);\n  return c.toDataURL(\"image/jpeg\",0.6);\n}\nasync function transcribe(blob){\n  const r=await fetch(\"/api/transcribe\",{method:\"POST\",headers:{\"Content-Type\":blob.type||\"audio/webm\"},body:blob});\n  const d=await r.json(); if(!r.ok) throw new Error(d.error||\"transcription failed\"); return d.text||\"\";\n}\nasync function decide(text){\n  if(busy||!text)return; busy=true;\n  try{\n    const d=await j(\"/api/decide\",{method:\"POST\",body:JSON.stringify({transcript:text,recentTranscript:recent.join(\" | \"),frameDataUrl:frame()})});\n    if(d.action===\"skip\"){ $(\"replyStatus\").textContent=`Stayed quiet (${d.reason})`; return; }\n    $(\"reply\").textContent=d.reply;\n    if(d.action===\"preview\"){ pending=d.reply; $(\"sendPreview\").disabled=false; $(\"replyStatus\").textContent=\"Preview ready\"; }\n    if(d.action===\"sent\"){ pending=\"\"; $(\"sendPreview\").disabled=true; $(\"replyStatus\").textContent=\"Sent \u2705\"; }\n  }catch(e){$(\"replyStatus\").textContent=e.message}finally{busy=false}\n}\n$(\"sendPreview\").onclick=async()=>{\n  try{\n    await j(\"/api/send-preview\",{method:\"POST\",body:JSON.stringify({reply:pending})});\n    $(\"replyStatus\").textContent=\"Sent \u2705\"; pending=\"\"; $(\"sendPreview\").disabled=true;\n  }catch(e){$(\"replyStatus\").textContent=e.message}\n};\nfunction nextChunk(){\n  if(!running||!stream)return;\n  const tracks=stream.getAudioTracks();\n  if(!tracks.length){$(\"watch\").textContent=\"No audio. Restart and enable Share tab audio.\";return}\n  const mime=[\"audio/webm;codecs=opus\",\"audio/webm\",\"video/webm\"].find(x=>MediaRecorder.isTypeSupported(x))||\"\";\n  const parts=[]; recorder=mime?new MediaRecorder(new MediaStream(tracks),{mimeType:mime}):new MediaRecorder(new MediaStream(tracks));\n  recorder.ondataavailable=e=>{if(e.data?.size)parts.push(e.data)};\n  recorder.onstop=async()=>{\n    if(!running)return;\n    setTimeout(nextChunk,40);\n    try{\n      const blob=new Blob(parts,{type:recorder.mimeType||\"audio/webm\"});\n      if(blob.size<1200)return;\n      $(\"watch\").textContent=\"Transcribing\u2026\";\n      const text=(await transcribe(blob)).trim();\n      if(!text){$(\"watch\").textContent=\"Watching \u2014 no clear speech\";return}\n      $(\"heard\").textContent=text; recent.push(text); recent=recent.slice(-4); log(\"Heard: \"+text);\n      await decide(text); $(\"watch\").textContent=\"Watching + listening\";\n    }catch(e){$(\"watch\").textContent=e.message}\n  };\n  recorder.start(); setTimeout(()=>{if(recorder?.state===\"recording\")recorder.stop()},9000);\n}\n$(\"start\").onclick=async()=>{\n  try{\n    stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});\n    if(!stream.getAudioTracks().length)throw new Error(\"Enable Share tab audio.\");\n    $(\"preview\").srcObject=stream; await $(\"preview\").play();\n    running=true;$(\"start\").disabled=true;$(\"stop\").disabled=false;$(\"watch\").textContent=\"Watching + listening\";\n    stream.getTracks().forEach(t=>t.addEventListener(\"ended\",()=>$(\"stop\").click()));\n    nextChunk();\n  }catch(e){$(\"watch\").textContent=e.message}\n};\n$(\"stop\").onclick=()=>{\n  running=false;try{if(recorder?.state===\"recording\")recorder.stop()}catch{}\n  try{stream?.getTracks().forEach(t=>t.stop())}catch{}\n  stream=null;$(\"preview\").srcObject=null;$(\"start\").disabled=false;$(\"stop\").disabled=true;$(\"watch\").textContent=\"Stopped\";\n};\nload().catch(e=>log(e.message));\n</script>\n</body>\n</html>";

// ---------- Basic dashboard protection ----------
app.use((req, res, next) => {
  // Kick callback is protected by the encrypted OAuth state cookie instead.
  if (req.path === "/auth/kick/callback" || req.path === "/health") return next();

  if (!DASHBOARD_PASSWORD) return next();

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : "";
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (user === "backendboys" && pass === DASHBOARD_PASSWORD) return next();
    } catch {}
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Backendboys AI"');
  return res.status(401).send("Login required.");
});

// ---------- Cookie encryption ----------
function keyBytes() {
  return crypto.createHash("sha256").update(SESSION_SECRET || "change-me").digest();
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const plain = Buffer.from(JSON.stringify(obj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv, tag, encrypted]
    .map(b => b.toString("base64url"))
    .join(".");
}

function unseal(value) {
  try {
    const [ivB64, tagB64, dataB64] = String(value || "").split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyBytes(),
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final()
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function appendSetCookie(res, value) {
  const current = res.getHeader("Set-Cookie");
  if (!current) res.setHeader("Set-Cookie", [value]);
  else if (Array.isArray(current)) res.setHeader("Set-Cookie", [...current, value]);
  else res.setHeader("Set-Cookie", [current, value]);
}

function setEncryptedCookie(res, name, obj, maxAgeSeconds) {
  const value = encodeURIComponent(seal(obj));
  appendSetCookie(
    res,
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function clearCookie(res, name) {
  appendSetCookie(
    res,
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function getEncryptedCookie(req, name) {
  return unseal(parseCookies(req)[name]);
}

// ---------- Anti-repeat ----------
const history = [];
const MAX_HISTORY = 60;
let lastSent = 0;

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/@[a-z0-9_]+/gi, "@user")
    .replace(/[^a-z0-9@\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const A = new Set(normalize(a).split(" ").filter(Boolean));
  const B = new Set(normalize(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  return intersection / new Set([...A, ...B]).size;
}

function isRepeat(candidate) {
  const c = normalize(candidate);
  return history.some(old => {
    const o = normalize(old);
    return (
      c === o ||
      (c.length >= 8 && o.length >= 8 && (c.includes(o) || o.includes(c))) ||
      similarity(candidate, old) >= 0.72
    );
  });
}

function remember(reply) {
  history.push(reply);
  while (history.length > MAX_HISTORY) history.shift();
}

function hasClearStreamerTrigger(transcript) {
  const t = String(transcript || "").toLowerCase().trim();
  if (!t) return false;

  // Direct questions / clear invitations are always strong triggers.
  if (/[?]/.test(t)) return true;

  // General emotional, conversational, or situational cues.
  // These are intentionally NOT gaming-specific.
  const triggerPatterns = [
    /(chat|yo|bro|bruh|gang|twin|my boy|look|watch|listen|hold on|wait)/i,
    /(no way|what the|wtf|damn|wow|crazy|wild|insane|funny|hilarious)/i,
    /(i love|i hate|i like|i don't like|i dont like|i can't believe|i cant believe)/i,
    /(how did|why did|what happened|what is|what was|who is|where is|when is)/i,
    /(y'all think|yall think|you think|should i|would you|did y'all|did yall|did you)/i,
    /(look at this|check this out|this is crazy|that's crazy|thats crazy)/i,
    /(lets go|let's go|finally|there we go|i knew it|called it)/i,
    /(ain't no way|aint no way|nahhh|nah bro|oh my god|omg)/i
  ];

  return triggerPatterns.some(rx => rx.test(t));
}

function isGenericBottyReply(reply) {
  const r = String(reply || "").toLowerCase().trim();

  // Phrases we specifically do NOT want during idle moments.
  const bannedPatterns = [
    /\bvibes?\b/i,
    /\benergy\b/i,
    /\bready for action\b/i,
    /\bready to roll\b/i,
    /\bsquad looks\b/i,
    /\bcrew'?s energy\b/i,
    /\banother level\b/i,
    /\bpower move\b/i,
    /\bstraight chillin'? let's go\b/i,
    /\bchill energy\b/i,
    /\bsolid, ready\b/i
  ];

  return bannedPatterns.some(rx => rx.test(r));
}

// ---------- Kick token helpers ----------
async function getKickToken(req, res) {
  let t = getEncryptedCookie(req, "bb_kick_token");
  if (!t?.access_token) throw new Error("Kick account is not authorized.");

  if (!t.expires_at || Date.now() < t.expires_at - 60_000) return t;

  if (!t.refresh_token) {
    clearCookie(res, "bb_kick_token");
    throw new Error("Kick token expired. Authorize the account again.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const r = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    clearCookie(res, "bb_kick_token");
    throw new Error(`Kick token refresh failed (${r.status}): ${JSON.stringify(data)}`);
  }

  t = {
    ...data,
    expires_at: data.expires_in
      ? Date.now() + Number(data.expires_in) * 1000
      : null
  };

  setEncryptedCookie(res, "bb_kick_token", t, 60 * 60 * 24 * 30);
  return t;
}

function getBroadcasterId(req) {
  const c = getEncryptedCookie(req, "bb_channel");
  return String(
    c?.broadcasterId ||
    process.env.KICK_BROADCASTER_USER_ID ||
    ""
  );
}

async function sendKick(req, res, content) {
  const t = await getKickToken(req, res);
  const broadcasterId = getBroadcasterId(req);

  if (!broadcasterId) {
    throw new Error("Resolve the broadcaster ID first.");
  }

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
  if (!r.ok) {
    throw new Error(`Kick send failed (${r.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- Pages ----------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));

// ---------- Kick OAuth ----------
app.get("/auth/kick/start", (_req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send(
      "Missing KICK_CLIENT_ID, KICK_CLIENT_SECRET, or KICK_REDIRECT_URI in Render Environment."
    );
  }

  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");

  setEncryptedCookie(
    res,
    "bb_oauth",
    { verifier, state, created: Date.now() },
    10 * 60
  );

  const qs = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "user:read channel:read chat:write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  res.redirect(`https://id.kick.com/oauth/authorize?${qs.toString()}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  try {
    const pending = getEncryptedCookie(req, "bb_oauth");
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    if (!pending || !code || state !== pending.state) {
      throw new Error("Kick OAuth state check failed. Start authorization again.");
    }

    if (Date.now() - Number(pending.created || 0) > 10 * 60 * 1000) {
      throw new Error("Kick OAuth request expired. Start authorization again.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier
    });

    const r = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`Kick token exchange failed (${r.status}): ${JSON.stringify(data)}`);
    }

    const t = {
      ...data,
      expires_at: data.expires_in
        ? Date.now() + Number(data.expires_in) * 1000
        : null
    };

    setEncryptedCookie(res, "bb_kick_token", t, 60 * 60 * 24 * 30);
    clearCookie(res, "bb_oauth");
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`<h2>Kick authorization error</h2><pre>${String(e.message || e)}</pre>`);
  }
});

app.get("/api/status", (req, res) => {
  const token = getEncryptedCookie(req, "bb_kick_token");
  res.json({
    kickAuthorized: Boolean(token?.access_token),
    broadcasterId: getBroadcasterId(req) || null,
    channelSlug: CHANNEL_SLUG,
    botName: BOT_NAME,
    streamerName: STREAMER_NAME,
    autoSend: AUTO_SEND
  });
});

// Raw audio MUST be before express.json()
app.post(
  "/api/transcribe",
  express.raw({
    type: ["audio/*", "video/webm", "application/octet-stream"],
    limit: "25mb"
  }),
  async (req, res) => {
    let tmp = null;
    try {
      if (!req.body?.length) return res.json({ text: "" });

      tmp = path.join(os.tmpdir(), `backendboys-${crypto.randomUUID()}.webm`);
      fs.writeFileSync(tmp, Buffer.from(req.body));

      const tx = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: TRANSCRIBE_MODEL
      });

      res.json({ text: String(tx.text || "").trim() });
    } catch (e) {
      res.status(500).json({ text: "", error: e.message || String(e) });
    } finally {
      if (tmp) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  }
);

app.use(express.json({ limit: "9mb" }));

app.post("/api/resolve-channel", async (req, res) => {
  try {
    const t = await getKickToken(req, res);
    const slug = String(req.body?.slug || CHANNEL_SLUG).trim();
    if (!slug) throw new Error("Enter the streamer Kick channel name.");

    const r = await fetch(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
      {
        headers: {
          Authorization: `Bearer ${t.access_token}`,
          Accept: "application/json"
        }
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Kick channel lookup failed (${r.status}): ${JSON.stringify(data)}`);

    const item = Array.isArray(data?.data) ? data.data[0] : data?.data;
    const broadcasterId = String(item?.broadcaster_user_id || "");

    if (!broadcasterId) {
      throw new Error("Kick returned no broadcaster_user_id for that channel.");
    }

    setEncryptedCookie(
      res,
      "bb_channel",
      { broadcasterId, slug },
      60 * 60 * 24 * 30
    );

    res.json({ ok: true, broadcasterId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/api/test", async (req, res) => {
  try {
    const content = String(req.body?.content || "AI co-host connection test ✅")
      .trim()
      .slice(0, 450);

    await sendKick(req, res, content);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/api/decide", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const recent = String(req.body?.recentTranscript || "").trim();
    const frame = String(req.body?.frameDataUrl || "");

    if (!transcript) {
      return res.json({ action: "skip", reason: "no speech" });
    }

    if (Date.now() - lastSent < MIN_SEND_INTERVAL_MS) {
      return res.json({ action: "skip", reason: "cooldown" });
    }

    // HARD IDLE GATE:
    // If the streamer is merely talking casually / sitting there with no clear
    // reaction, question, joke, or event, stay silent.
    if (!hasClearStreamerTrigger(transcript)) {
      return res.json({ action: "skip", reason: "no clear moment to respond to" });
    }

    const content = [{
      type: "input_text",
      text: `You are ${BOT_NAME}, a clearly identified AI co-host for ${STREAMER_NAME}'s Kick stream.

Current speech:
${transcript}

Recent speech:
${recent || "(none)"}

Recent AI replies:
${history.slice(-15).join("\n") || "(none)"}

CONTEXT-FIRST BEHAVIOR:
- First determine what kind of moment is actually happening RIGHT NOW from the speech + screenshot.
- Do NOT assume this is gaming.
- The stream may be gaming, Just Chatting, IRL, cars, cooking, music, reactions, shopping, storytelling, sports, tutorials, unboxing, travel, or something else.
- Adapt your vocabulary and reaction to the actual scene.
- Your default state is SILENCE.
- If the streamer is simply sitting, chilling, waiting, scrolling, browsing, driving quietly, eating, or casually talking with no clear moment to respond to, output exactly SKIP.
- Never send generic hype just because the stream is live.
- Reply only when there is a clear reason: a direct question, obvious joke, strong reaction, surprising visual moment, interesting statement, disagreement, reveal, accomplishment, mistake, awkward/funny moment, or the streamer clearly invites a response.
- The screenshot is evidence. Do not invent an event that is not visible or supported by the speech.
- If the speech and screenshot disagree, be conservative and output SKIP.
- If you are not at least 85% sure a response improves the moment, output exactly SKIP.

CONTEXT EXAMPLES:
- Gaming: react to the actual play, death, win, miss, clutch, menu choice, etc.
- Just Chatting: respond to the specific story, opinion, joke, or question being discussed.
- Cars: react to the actual car, mod, sound, comparison, problem, or reveal on screen.
- Cooking/food: react to the actual dish, ingredient, result, mistake, or taste discussion.
- IRL: react to what visibly happens around the streamer or what they specifically say.
- Music: react to the discussion/performance without quoting lyrics.
- Reactions/videos: react to the specific thing the streamer is reacting to, not generic "vibes."
- Shopping/unboxing: react to the actual item, price, feature, reveal, or opinion.

STYLE:
- 2-10 words most of the time.
- Casual stream-chat tone, not polished assistant language.
- Match the topic naturally. Do not force gaming terms into non-gaming streams.
- Light slang is okay occasionally: bruh, gang, my boy, twin, ngl, lowkey, fr, cooked, sold, locked in.
- Most replies should use no slang.
- Never stack slang.
- Never use generic filler such as "vibes are solid", "energy is on another level", "ready for action", "ready to roll", "power move", or similar hype-template language.
- Never pretend to be a human viewer or claim personal human experiences.
- Do not repeat or lightly reword recent replies.
- If you cannot make a SPECIFIC reply tied to what JUST happened or what the streamer JUST said, output exactly SKIP.

Return only the short chat message or exactly SKIP.`
    }];

    if (frame.startsWith("data:image/")) {
      content.push({
        type: "input_image",
        image_url: frame,
        detail: "low"
      });
    }

    const out = await openai.responses.create({
      model: DECISION_MODEL,
      input: [{ role: "user", content }]
    });

    const reply = String(out.output_text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 450);

    if (!reply || reply.toUpperCase() === "SKIP") {
      return res.json({ action: "skip", reason: "model" });
    }

    if (isRepeat(reply)) {
      return res.json({ action: "skip", reason: "repeat" });
    }

    if (isGenericBottyReply(reply)) {
      return res.json({ action: "skip", reason: "generic botty reply blocked" });
    }

    if (!AUTO_SEND) {
      return res.json({ action: "preview", reply });
    }

    // Small natural pause after deciding, instead of instant posting.
    const naturalDelayMs = 2500 + Math.floor(Math.random() * 4500);
    await new Promise(resolve => setTimeout(resolve, naturalDelayMs));

    await sendKick(req, res, reply);
    lastSent = Date.now();
    remember(reply);

    res.json({ action: "sent", reply });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/send-preview", async (req, res) => {
  try {
    const reply = String(req.body?.reply || "").trim().slice(0, 450);
    if (!reply) throw new Error("No reply supplied.");
    if (isRepeat(reply)) throw new Error("Anti-repeat blocked this message.");

    await sendKick(req, res, reply);
    lastSent = Date.now();
    remember(reply);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/api/logout-kick", (_req, res) => {
  clearCookie(res, "bb_kick_token");
  clearCookie(res, "bb_channel");
  res.json({ ok: true });
});

// Render requires 0.0.0.0 and its PORT environment variable.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backendboys AI dashboard running on port ${PORT}`);
});
