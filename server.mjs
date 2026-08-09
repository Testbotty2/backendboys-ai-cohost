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

const DIRECTOR_MODEL = process.env.OPENAI_DIRECTOR_MODEL || "gpt-5.6";
const WRITER_MODEL = process.env.OPENAI_WRITER_MODEL || "gpt-5.6";
const CRITIC_MODEL = process.env.OPENAI_CRITIC_MODEL || "gpt-5.6";
const FALLBACK_TRANSCRIBE_MODEL =
  process.env.OPENAI_FALLBACK_TRANSCRIBE_MODEL || "gpt-transcribe";
const REALTIME_TRANSCRIBE_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-live-transcribe";

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

if (!SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const DASHBOARD_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Backendboys Advanced Brain</title>\n<style>\n:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:#09090b;color:#f4f4f5}\nmain{max-width:980px;margin:28px auto 80px;padding:0 16px}\nheader{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:18px}\nh1{margin:4px 0;font-size:clamp(28px,5vw,44px)}\nh2{font-size:18px;margin:0 0 12px}\np{color:#a1a1aa;line-height:1.5}\n.eyebrow{font-size:11px;letter-spacing:.14em;color:#71717a}\n.card{background:#131316;border:1px solid #29292e;border-radius:16px;padding:18px;margin:13px 0}\n.row{display:flex;gap:9px;flex-wrap:wrap;margin:10px 0}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}\nbutton,.btn{border:1px solid #3f3f46;background:#232327;color:#fff;padding:10px 13px;border-radius:9px;cursor:pointer;text-decoration:none;font-weight:650}\nbutton:disabled{opacity:.45;cursor:not-allowed}\n.primary{background:#fafafa;color:#09090b;border-color:#fafafa}\n.danger{border-color:#7f1d1d}\ninput{width:100%;padding:11px;border-radius:9px;border:1px solid #3f3f46;background:#0c0c0f;color:#fff;margin:7px 0}\n.status{color:#a1a1aa;min-height:20px;word-break:break-word}\n.big{color:#f4f4f5;font-size:16px}\n.label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#71717a;margin-bottom:5px}\n.reply{font-size:20px;background:#0c0c0f;border:1px solid #27272a;border-radius:12px;padding:14px;min-height:55px}\n.brain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#0c0c0f;border-radius:10px;padding:12px;white-space:pre-wrap;min-height:74px}\nvideo{width:100%;max-height:360px;background:#000;border-radius:12px;margin-top:12px}\npre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:#0c0c0f;border-radius:10px;padding:12px;color:#a7f3d0;font-size:12px}\n.badge{padding:7px 10px;border:1px solid #3f3f46;border-radius:999px;font-size:12px;white-space:nowrap}\nstrong{color:#fff}\n@media(max-width:700px){header{flex-direction:column}.grid{grid-template-columns:1fr}}\n</style>\n</head>\n<body>\n<main>\n<header>\n  <div>\n    <div class=\"eyebrow\">BACKENDBOYS \u2022 ADVANCED BRAIN V5</div>\n    <h1>AI Co-host</h1>\n    <p>Realtime hearing \u2022 multi-frame vision \u2022 director \u2192 writer \u2192 critic \u2022 persistent stream memory</p>\n  </div>\n  <div id=\"badge\" class=\"badge\">Loading\u2026</div>\n</header>\n\n<section class=\"card\">\n  <h2>1. Kick connection</h2>\n  <div class=\"row\">\n    <a class=\"btn primary\" href=\"/auth/kick/start\">Authorize AI Kick account</a>\n  </div>\n  <div id=\"kickStatus\" class=\"status\">Checking\u2026</div>\n</section>\n\n<section class=\"card\">\n  <h2>2. Stream channel</h2>\n  <input id=\"slug\" placeholder=\"Streamer Kick username\">\n  <button id=\"resolve\">Resolve broadcaster ID</button>\n  <div id=\"channelStatus\" class=\"status\">Not resolved.</div>\n</section>\n\n<section class=\"card\">\n  <h2>3. Official Kick API test</h2>\n  <input id=\"testText\" value=\"AI co-host connection test \u2705\">\n  <button id=\"test\">Send test message</button>\n  <div id=\"testStatus\" class=\"status\"></div>\n</section>\n\n<section class=\"card\">\n  <h2>4. Advanced stream watch</h2>\n  <p>Open the live Kick stream in another tab. Click Start, select that tab, and enable <strong>Share tab audio</strong>.</p>\n  <div class=\"row\">\n    <button id=\"start\" class=\"primary\">Start Advanced Watch</button>\n    <button id=\"stop\" class=\"danger\" disabled>Stop</button>\n  </div>\n\n  <div class=\"grid\">\n    <div>\n      <div class=\"label\">Hearing mode</div>\n      <div id=\"hearingMode\" class=\"status big\">Stopped</div>\n    </div>\n    <div>\n      <div class=\"label\">Latest heard</div>\n      <div id=\"heard\" class=\"status big\">(nothing yet)</div>\n    </div>\n  </div>\n\n  <video id=\"preview\" muted playsinline></video>\n</section>\n\n<section class=\"card\">\n  <h2>5. Brain state</h2>\n  <div id=\"brainState\" class=\"brain\">Waiting for stream context\u2026</div>\n  <div class=\"row\">\n    <button id=\"resetMemory\">Reset stream memory</button>\n  </div>\n  <div id=\"memoryStatus\" class=\"status\"></div>\n</section>\n\n<section class=\"card\">\n  <h2>6. Latest AI reply</h2>\n  <div id=\"modeStatus\" class=\"status\"></div>\n  <div id=\"reply\" class=\"reply\">(waiting)</div>\n  <button id=\"sendPreview\" disabled>Send preview to Kick</button>\n  <div id=\"replyStatus\" class=\"status\"></div>\n</section>\n\n<section class=\"card\">\n  <h2>Log</h2>\n  <pre id=\"log\"></pre>\n</section>\n</main>\n\n<script>\nconst $ = id => document.getElementById(id);\nconst MEM_KEY = \"backendboys_advanced_memory_v5\";\n\nlet statusInfo = null;\nlet captureStream = null;\nlet running = false;\nlet busy = false;\nlet pendingPreview = \"\";\n\nlet rtcPc = null;\nlet rtcDc = null;\nlet rtcConnected = false;\nlet fallbackRecorder = null;\nlet fallbackTimer = null;\n\nlet frameTimer = null;\nlet proactiveTimer = null;\nlet audioMeterTimer = null;\nlet audioContext = null;\nlet analyser = null;\n\nlet frameHistory = [];\nlet recentTranscripts = [];\nlet completedItems = new Set();\nlet liveDelta = \"\";\nlet lastTranscriptAt = 0;\nlet recentAudioLevels = [];\n\nfunction defaultMemory(){\n  return {\n    facts: [],\n    runningJokes: [],\n    recentDialogue: [],\n    currentTopic: \"\",\n    streamCategory: \"unknown\",\n    mood: \"unknown\",\n    energy: \"unknown\",\n    conversation: {active:false, topic:\"\", turns:0, lastAt:0},\n    lastUpdated: Date.now()\n  };\n}\n\nfunction loadMemory(){\n  try {\n    const raw = localStorage.getItem(MEM_KEY);\n    if(!raw) return defaultMemory();\n    return {...defaultMemory(), ...JSON.parse(raw)};\n  } catch { return defaultMemory(); }\n}\n\nlet memoryState = loadMemory();\n\nfunction saveMemory(){\n  memoryState.lastUpdated = Date.now();\n  localStorage.setItem(MEM_KEY, JSON.stringify(memoryState));\n  $(\"memoryStatus\").textContent =\n    `${memoryState.facts.length} remembered facts \u2022 ${memoryState.recentDialogue.length} dialogue items`;\n}\n\nfunction addDialogue(role,text){\n  const clean = String(text||\"\").replace(/\\s+/g,\" \").trim();\n  if(!clean) return;\n  memoryState.recentDialogue.push({role,text:clean,at:Date.now()});\n  memoryState.recentDialogue = memoryState.recentDialogue.slice(-30);\n  saveMemory();\n}\n\nfunction addUnique(list,value,max){\n  const clean = String(value||\"\").replace(/\\s+/g,\" \").trim();\n  if(!clean) return list;\n  const exists = list.some(x => String(x).toLowerCase() === clean.toLowerCase());\n  if(!exists) list.push(clean);\n  return list.slice(-max);\n}\n\nfunction applyBrainMemory(director){\n  if(!director) return;\n\n  memoryState.currentTopic = director.topic || memoryState.currentTopic;\n  memoryState.streamCategory = director.stream_category || memoryState.streamCategory;\n  memoryState.mood = director.streamer_mood || memoryState.mood;\n  memoryState.energy = director.energy || memoryState.energy;\n\n  for(const fact of (director.memory_updates || [])){\n    memoryState.facts = addUnique(memoryState.facts,fact,45);\n  }\n\n  if(director.running_joke_candidate){\n    memoryState.runningJokes =\n      addUnique(memoryState.runningJokes,director.running_joke_candidate,12);\n  }\n\n  const action = director.conversation_action;\n  if(action === \"start\"){\n    memoryState.conversation = {\n      active:true,\n      topic:director.topic || director.specific_reference || \"\",\n      turns:1,\n      lastAt:Date.now()\n    };\n  } else if(action === \"continue\" && memoryState.conversation.active){\n    memoryState.conversation.turns += 1;\n    memoryState.conversation.lastAt = Date.now();\n  } else if(action === \"end\"){\n    memoryState.conversation.active = false;\n  }\n\n  // Let stale conversations expire.\n  if(memoryState.conversation.active &&\n     Date.now() - memoryState.conversation.lastAt > 120000){\n    memoryState.conversation.active = false;\n  }\n\n  saveMemory();\n}\n\nfunction log(...args){\n  const line = `[${new Date().toLocaleTimeString()}] ${args.join(\" \")}`;\n  $(\"log\").textContent = `${line}\\n${$(\"log\").textContent}`.slice(0,16000);\n}\n\nasync function jf(url,options={}){\n  const headers = {...(options.headers||{})};\n  if(options.body && !(options.body instanceof Blob) &&\n     !(options.body instanceof FormData) &&\n     !headers[\"Content-Type\"]){\n    headers[\"Content-Type\"]=\"application/json\";\n  }\n  const r = await fetch(url,{...options,headers});\n  const d = await r.json().catch(()=>({}));\n  if(!r.ok) throw new Error(d.error || `${r.status} ${r.statusText}`);\n  return d;\n}\n\nasync function loadStatus(){\n  statusInfo = await jf(\"/api/status\");\n  $(\"kickStatus\").textContent =\n    statusInfo.kickAuthorized ? \"Kick authorized \u2705\" : \"Kick not authorized\";\n  $(\"slug\").value = statusInfo.channelSlug || \"\";\n  $(\"channelStatus\").textContent =\n    statusInfo.broadcasterId ? `Broadcaster ID: ${statusInfo.broadcasterId} \u2705` : \"Not resolved.\";\n  $(\"modeStatus\").textContent =\n    statusInfo.autoSend\n      ? \"AUTO_SEND=true \u2014 approved replies post automatically.\"\n      : \"AUTO_SEND=false \u2014 replies wait for manual approval.\";\n  $(\"badge\").textContent = statusInfo.kickAuthorized ? \"Kick connected\" : \"Setup needed\";\n  saveMemory();\n}\n\n$(\"resolve\").onclick = async()=>{\n  try{\n    $(\"channelStatus\").textContent=\"Resolving\u2026\";\n    const d=await jf(\"/api/resolve-channel\",{\n      method:\"POST\",\n      body:JSON.stringify({slug:$(\"slug\").value.trim()})\n    });\n    $(\"channelStatus\").textContent=`Broadcaster ID: ${d.broadcasterId} \u2705`;\n  }catch(e){\n    $(\"channelStatus\").textContent=`Error: ${e.message}`;\n  }\n};\n\n$(\"test\").onclick=async()=>{\n  try{\n    $(\"testStatus\").textContent=\"Sending\u2026\";\n    await jf(\"/api/test\",{\n      method:\"POST\",\n      body:JSON.stringify({content:$(\"testText\").value})\n    });\n    $(\"testStatus\").textContent=\"Sent \u2705\";\n  }catch(e){\n    $(\"testStatus\").textContent=`Error: ${e.message}`;\n  }\n};\n\n$(\"resetMemory\").onclick=()=>{\n  memoryState=defaultMemory();\n  localStorage.removeItem(MEM_KEY);\n  saveMemory();\n  $(\"brainState\").textContent=\"Stream memory reset.\";\n  log(\"Persistent stream memory reset.\");\n};\n\nfunction frameSample(){\n  const v=$(\"preview\");\n  if(!v.srcObject || v.readyState<2 || !v.videoWidth) return;\n\n  const width=Math.min(576,v.videoWidth);\n  const height=Math.max(1,Math.round(v.videoHeight/v.videoWidth*width));\n  const c=document.createElement(\"canvas\");\n  c.width=width;c.height=height;\n  const ctx=c.getContext(\"2d\",{alpha:false});\n  ctx.drawImage(v,0,0,width,height);\n\n  // Lightweight local visual signature.\n  const sw=16, sh=9;\n  const tiny=document.createElement(\"canvas\");\n  tiny.width=sw;tiny.height=sh;\n  const tctx=tiny.getContext(\"2d\",{alpha:false});\n  tctx.drawImage(v,0,0,sw,sh);\n  const px=tctx.getImageData(0,0,sw,sh).data;\n  let sig=[];\n  for(let i=0;i<px.length;i+=16){\n    sig.push((px[i]+px[i+1]+px[i+2])/765);\n  }\n\n  let change=0;\n  const prev=frameHistory.at(-1);\n  if(prev?.signature?.length===sig.length){\n    let sum=0;\n    for(let i=0;i<sig.length;i++) sum+=Math.abs(sig[i]-prev.signature[i]);\n    change=sum/sig.length;\n  }\n\n  const item={\n    dataUrl:c.toDataURL(\"image/jpeg\",0.58),\n    at:Date.now(),\n    change:Number(change.toFixed(4)),\n    signature:sig\n  };\n\n  // Keep moving frames; also refresh a static scene every ~10 sec.\n  if(!prev || change>0.025 || Date.now()-prev.at>10000){\n    frameHistory.push(item);\n    frameHistory=frameHistory.slice(-5);\n  }\n}\n\nfunction getFramesForBrain(){\n  return frameHistory.slice(-3).map(x=>({\n    dataUrl:x.dataUrl,\n    at:x.at,\n    change:x.change\n  }));\n}\n\nfunction startAudioMeter(){\n  try{\n    audioContext = new (window.AudioContext||window.webkitAudioContext)();\n    const audioTrack = captureStream.getAudioTracks()[0];\n    const source=audioContext.createMediaStreamSource(new MediaStream([audioTrack]));\n    analyser=audioContext.createAnalyser();\n    analyser.fftSize=1024;\n    source.connect(analyser);\n\n    const data=new Uint8Array(analyser.fftSize);\n    audioMeterTimer=setInterval(()=>{\n      analyser.getByteTimeDomainData(data);\n      let sum=0, peak=0;\n      for(const b of data){\n        const x=(b-128)/128;\n        sum+=x*x;\n        peak=Math.max(peak,Math.abs(x));\n      }\n      const rms=Math.sqrt(sum/data.length);\n      recentAudioLevels.push({rms,peak,at:Date.now()});\n      recentAudioLevels=recentAudioLevels.slice(-100);\n    },200);\n  }catch(e){\n    log(\"Audio meter unavailable:\",e.message);\n  }\n}\n\nfunction getAudioMetrics(){\n  const vals=recentAudioLevels.slice(-30);\n  if(!vals.length) return {avg_rms:0,peak:0};\n  const avg=vals.reduce((a,x)=>a+x.rms,0)/vals.length;\n  const peak=Math.max(...vals.map(x=>x.peak));\n  return {\n    avg_rms:Number(avg.toFixed(4)),\n    peak:Number(peak.toFixed(4))\n  };\n}\n\nfunction brainText(d){\n  if(!d) return \"No director decision yet.\";\n  return [\n    `category: ${d.stream_category}`,\n    `topic: ${d.topic}`,\n    `moment: ${d.moment_type}`,\n    `mood / energy: ${d.streamer_mood} / ${d.energy}`,\n    `intent: ${d.response_intent}`,\n    `conversation: ${d.conversation_action}`,\n    `confidence: ${Math.round((d.confidence||0)*100)}%`,\n    `specific reference: ${d.specific_reference || \"(none)\"}`,\n    `decision: ${d.should_reply ? \"reply\" : \"stay quiet\"}`,\n    `reason: ${d.reason}`\n  ].join(\"\\n\");\n}\n\nasync function callBrain(transcript,{proactive=false}={}){\n  if(!running || busy) return;\n  busy=true;\n\n  try{\n    const payload={\n      transcript:transcript||\"\",\n      recentTranscript:recentTranscripts.slice(-10).join(\" | \"),\n      frames:getFramesForBrain(),\n      memory:memoryState,\n      audioMetrics:getAudioMetrics(),\n      proactiveTick:proactive\n    };\n\n    const d=await jf(\"/api/brain\",{\n      method:\"POST\",\n      body:JSON.stringify(payload)\n    });\n\n    if(d.director){\n      $(\"brainState\").textContent=brainText(d.director);\n      applyBrainMemory(d.director);\n    }\n\n    if(d.action===\"skip\"){\n      $(\"replyStatus\").textContent=`Stayed quiet (${d.reason||\"skip\"})`;\n      log(\"Brain skipped:\",d.reason||\"\");\n      return;\n    }\n\n    if(d.action===\"preview\"){\n      pendingPreview=d.reply;\n      $(\"reply\").textContent=d.reply;\n      $(\"replyStatus\").textContent=\"Preview ready.\";\n      $(\"sendPreview\").disabled=false;\n      addDialogue(\"ai\",d.reply);\n      return;\n    }\n\n    if(d.action===\"sent\"){\n      pendingPreview=\"\";\n      $(\"reply\").textContent=d.reply;\n      $(\"replyStatus\").textContent=\"Sent to Kick \u2705\";\n      $(\"sendPreview\").disabled=true;\n      addDialogue(\"ai\",d.reply);\n      log(\"Sent:\",d.reply);\n    }\n  }catch(e){\n    $(\"replyStatus\").textContent=`Brain error: ${e.message}`;\n    log(\"Brain error:\",e.message);\n  }finally{\n    busy=false;\n  }\n}\n\n$(\"sendPreview\").onclick=async()=>{\n  if(!pendingPreview) return;\n  try{\n    $(\"sendPreview\").disabled=true;\n    await jf(\"/api/send-preview\",{\n      method:\"POST\",\n      body:JSON.stringify({reply:pendingPreview})\n    });\n    $(\"replyStatus\").textContent=\"Sent to Kick \u2705\";\n    addDialogue(\"ai\",pendingPreview);\n    pendingPreview=\"\";\n  }catch(e){\n    $(\"replyStatus\").textContent=`Error: ${e.message}`;\n    $(\"sendPreview\").disabled=false;\n  }\n};\n\nasync function handleFinalTranscript(itemId,text){\n  if(!text || completedItems.has(itemId)) return;\n  completedItems.add(itemId);\n  if(completedItems.size>100){\n    completedItems=new Set([...completedItems].slice(-50));\n  }\n\n  const clean=String(text).replace(/\\s+/g,\" \").trim();\n  if(!clean) return;\n\n  liveDelta=\"\";\n  lastTranscriptAt=Date.now();\n  $(\"heard\").textContent=clean;\n\n  recentTranscripts.push(clean);\n  recentTranscripts=recentTranscripts.slice(-12);\n  addDialogue(\"streamer\",clean);\n  log(\"Realtime heard:\",clean);\n\n  await callBrain(clean,{proactive:false});\n}\n\nfunction handleRealtimeEvent(event){\n  if(event.type===\"conversation.item.input_audio_transcription.delta\"){\n    liveDelta += event.delta || \"\";\n    $(\"heard\").textContent = liveDelta.slice(-500) || \"(listening)\";\n  }\n\n  if(event.type===\"conversation.item.input_audio_transcription.completed\"){\n    handleFinalTranscript(event.item_id,event.transcript);\n  }\n\n  if(event.type===\"input_audio_buffer.speech_started\"){\n    liveDelta=\"\";\n    $(\"hearingMode\").textContent=\"Realtime \u2022 speech detected\";\n  }\n\n  if(event.type===\"input_audio_buffer.speech_stopped\"){\n    $(\"hearingMode\").textContent=\"Realtime \u2022 processing turn\";\n  }\n\n  if(event.type===\"error\"){\n    log(\"Realtime API error:\",JSON.stringify(event.error||event));\n  }\n}\n\nasync function connectRealtime(){\n  const token=await jf(\"/api/realtime-token\",{method:\"POST\",body:JSON.stringify({})});\n  const key=token.value;\n  if(!key) throw new Error(\"Realtime client secret did not contain a value.\");\n\n  rtcPc=new RTCPeerConnection();\n  rtcPc.onconnectionstatechange=()=>{\n    log(\"Realtime connection:\",rtcPc.connectionState);\n    if(rtcPc.connectionState===\"connected\"){\n      rtcConnected=true;\n      $(\"hearingMode\").textContent=\"Realtime hearing \u2705\";\n    }\n  };\n\n  const track=captureStream.getAudioTracks()[0];\n  rtcPc.addTrack(track,new MediaStream([track]));\n\n  rtcDc=rtcPc.createDataChannel(\"oai-events\");\n  rtcDc.onmessage=e=>{\n    try{handleRealtimeEvent(JSON.parse(e.data))}\n    catch(err){log(\"Realtime event parse error:\",err.message)}\n  };\n  rtcDc.onopen=()=>log(\"Realtime event channel open.\");\n  rtcDc.onerror=()=>log(\"Realtime data channel error.\");\n\n  const offer=await rtcPc.createOffer();\n  await rtcPc.setLocalDescription(offer);\n\n  const r=await fetch(\"https://api.openai.com/v1/realtime/calls\",{\n    method:\"POST\",\n    body:offer.sdp,\n    headers:{\n      Authorization:`Bearer ${key}`,\n      \"Content-Type\":\"application/sdp\"\n    }\n  });\n\n  if(!r.ok){\n    throw new Error(`Realtime WebRTC failed (${r.status}): ${await r.text()}`);\n  }\n\n  await rtcPc.setRemoteDescription({\n    type:\"answer\",\n    sdp:await r.text()\n  });\n}\n\nfunction chooseFallbackMime(){\n  const opts=[\"audio/webm;codecs=opus\",\"audio/webm\",\"video/webm\"];\n  return opts.find(x=>MediaRecorder.isTypeSupported(x))||\"\";\n}\n\nfunction startFallbackChunk(){\n  if(!running || rtcConnected) return;\n  const tracks=captureStream?.getAudioTracks()||[];\n  if(!tracks.length) return;\n\n  const parts=[];\n  const mime=chooseFallbackMime();\n  fallbackRecorder=mime\n    ? new MediaRecorder(new MediaStream(tracks),{mimeType:mime})\n    : new MediaRecorder(new MediaStream(tracks));\n\n  fallbackRecorder.ondataavailable=e=>{\n    if(e.data?.size) parts.push(e.data);\n  };\n\n  fallbackRecorder.onstop=async()=>{\n    if(!running || rtcConnected) return;\n    fallbackTimer=setTimeout(startFallbackChunk,50);\n\n    try{\n      const blob=new Blob(parts,{type:fallbackRecorder.mimeType||\"audio/webm\"});\n      if(blob.size<1200) return;\n      $(\"hearingMode\").textContent=\"Fallback transcription\u2026\";\n\n      const r=await fetch(\"/api/transcribe-fallback\",{\n        method:\"POST\",\n        headers:{\"Content-Type\":blob.type||\"audio/webm\"},\n        body:blob\n      });\n      const d=await r.json();\n      if(!r.ok) throw new Error(d.error||\"Fallback transcription failed\");\n\n      const text=String(d.text||\"\").trim();\n      if(text){\n        await handleFinalTranscript(`fallback-${Date.now()}`,text);\n      }\n      $(\"hearingMode\").textContent=\"Fallback hearing\";\n    }catch(e){\n      log(\"Fallback audio error:\",e.message);\n    }\n  };\n\n  fallbackRecorder.start();\n  setTimeout(()=>{\n    if(fallbackRecorder?.state===\"recording\") fallbackRecorder.stop();\n  },5000);\n}\n\nasync function startWatch(){\n  if(running) return;\n\n  try{\n    captureStream=await navigator.mediaDevices.getDisplayMedia({\n      video:{\n        frameRate:{ideal:5,max:10},\n        width:{ideal:1280},\n        height:{ideal:720}\n      },\n      audio:true\n    });\n\n    if(!captureStream.getAudioTracks().length){\n      captureStream.getTracks().forEach(t=>t.stop());\n      captureStream=null;\n      throw new Error(\"No audio shared. Restart and enable Share tab audio.\");\n    }\n\n    $(\"preview\").srcObject=captureStream;\n    $(\"preview\").muted=true;\n    await $(\"preview\").play();\n\n    running=true;\n    lastTranscriptAt=Date.now();\n    frameHistory=[];\n    recentAudioLevels=[];\n\n    $(\"start\").disabled=true;\n    $(\"stop\").disabled=false;\n    $(\"hearingMode\").textContent=\"Connecting Realtime hearing\u2026\";\n\n    captureStream.getTracks().forEach(t=>{\n      t.addEventListener(\"ended\",()=>stopWatch());\n    });\n\n    frameSample();\n    frameTimer=setInterval(frameSample,3000);\n    startAudioMeter();\n\n    // Proactive grounded conversation check every 25 seconds.\n    proactiveTimer=setInterval(()=>{\n      if(!running || busy) return;\n      if(Date.now()-lastTranscriptAt>90000){\n        callBrain(\"\",{proactive:true});\n      }\n    },25000);\n\n    try{\n      await connectRealtime();\n    }catch(e){\n      rtcConnected=false;\n      $(\"hearingMode\").textContent=\"Realtime unavailable \u2022 fallback active\";\n      log(\"Realtime unavailable, using fallback:\",e.message);\n      startFallbackChunk();\n    }\n  }catch(e){\n    $(\"hearingMode\").textContent=e.message;\n    log(\"Start error:\",e.message);\n  }\n}\n\nfunction stopWatch(){\n  if(!running && !captureStream) return;\n  running=false;\n  rtcConnected=false;\n\n  clearInterval(frameTimer);\n  clearInterval(proactiveTimer);\n  clearInterval(audioMeterTimer);\n  clearTimeout(fallbackTimer);\n\n  try{if(fallbackRecorder?.state===\"recording\") fallbackRecorder.stop()}catch{}\n  try{rtcDc?.close()}catch{}\n  try{rtcPc?.close()}catch{}\n  try{audioContext?.close()}catch{}\n  try{captureStream?.getTracks().forEach(t=>t.stop())}catch{}\n\n  captureStream=null;\n  rtcPc=null;\n  rtcDc=null;\n  fallbackRecorder=null;\n  audioContext=null;\n  analyser=null;\n  $(\"preview\").srcObject=null;\n\n  $(\"start\").disabled=false;\n  $(\"stop\").disabled=true;\n  $(\"hearingMode\").textContent=\"Stopped\";\n  log(\"Advanced watcher stopped.\");\n}\n\n$(\"start\").onclick=startWatch;\n$(\"stop\").onclick=stopWatch;\n\nloadStatus().catch(e=>log(\"Status error:\",e.message));\n</script>\n</body>\n</html>";

// ---------------- Dashboard password protection ----------------
app.use((req,res,next)=>{
  if(req.path==="/auth/kick/callback" || req.path==="/health") return next();
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

// ---------------- Kick token helpers ----------------
async function getKickToken(req,res){
  let t=getEncryptedCookie(req,"bb_kick_token");
  if(!t?.access_token) throw new Error("Kick account is not authorized.");

  if(!t.expires_at || Date.now()<t.expires_at-60000) return t;
  if(!t.refresh_token) throw new Error("Kick token expired. Authorize again.");

  const body=new URLSearchParams({
    grant_type:"refresh_token",
    refresh_token:t.refresh_token,
    client_id:CLIENT_ID,
    client_secret:CLIENT_SECRET
  });

  const r=await fetch("https://id.kick.com/oauth/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });

  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    clearCookie(res,"bb_kick_token");
    throw new Error(`Kick token refresh failed (${r.status}): ${JSON.stringify(data)}`);
  }

  t={
    ...data,
    expires_at:data.expires_in
      ? Date.now()+Number(data.expires_in)*1000
      : null
  };

  setEncryptedCookie(res,"bb_kick_token",t,60*60*24*30);
  return t;
}

function broadcasterId(req){
  return String(
    getEncryptedCookie(req,"bb_channel")?.broadcasterId ||
    process.env.KICK_BROADCASTER_USER_ID ||
    ""
  );
}

async function sendKick(req,res,content){
  const t=await getKickToken(req,res);
  const id=broadcasterId(req);
  if(!id) throw new Error("Resolve the broadcaster ID first.");

  const r=await fetch("https://api.kick.com/public/v1/chat",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${t.access_token}`,
      "Content-Type":"application/json",
      Accept:"application/json"
    },
    body:JSON.stringify({
      broadcaster_user_id:Number(id),
      content,
      type:"user"
    })
  });

  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    throw new Error(`Kick send failed (${r.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------------- Reply history / hard filters ----------------
const replyHistory=[];
const MAX_REPLY_HISTORY=80;
let lastSentAt=0;
let nextProactiveAt=Date.now()+randomProactiveDelay();

function randomProactiveDelay(){
  const min=Math.max(60000,PROACTIVE_MIN_MS);
  const max=Math.max(min,PROACTIVE_MAX_MS);
  return min+Math.floor(Math.random()*(max-min+1));
}

function scheduleNextProactive(){
  nextProactiveAt=Date.now()+randomProactiveDelay();
}

function normalizeReply(s){
  return String(s||"")
    .toLowerCase()
    .replace(/@[a-z0-9_]+/gi,"@user")
    .replace(/[’']/g,"")
    .replace(/[^a-z0-9@\s]/gi," ")
    .replace(/\s+/g," ")
    .trim();
}

function tokenSet(s){
  return new Set(normalizeReply(s).split(" ").filter(Boolean));
}

function similarity(a,b){
  const A=tokenSet(a),B=tokenSet(b);
  if(!A.size||!B.size) return 0;
  let intersection=0;
  for(const x of A) if(B.has(x)) intersection++;
  return intersection/new Set([...A,...B]).size;
}

function isRepeat(reply){
  const r=normalizeReply(reply);
  if(!r) return true;

  return replyHistory.some(old=>{
    const o=normalizeReply(old);
    return (
      r===o ||
      (r.length>=8 && o.length>=8 && (r.includes(o)||o.includes(r))) ||
      similarity(reply,old)>=0.70
    );
  });
}

function isGenericBottyReply(reply){
  const r=normalizeReply(reply);
  const patterns=[
    /\bvibes?\b/i,
    /\benergy is\b/i,
    /\bready for action\b/i,
    /\bready to roll\b/i,
    /\bpower move\b/i,
    /\bwhole mood\b/i,
    /\bwe love to see it\b/i,
    /\bthats the vibe\b/i,
    /\bmain character energy\b/i,
    /\bkeep the momentum\b/i,
    /\blets keep it going\b/i,
    /\bgreat job\b/i,
    /\bthat was impressive\b/i,
    /\bbetter luck next time\b/i
  ];
  return patterns.some(rx=>rx.test(r));
}

function rememberReply(reply){
  replyHistory.push(reply);
  while(replyHistory.length>MAX_REPLY_HISTORY) replyHistory.shift();
}

// ---------------- Structured-output schemas ----------------
const directorSchema={
  type:"object",
  properties:{
    should_reply:{type:"boolean"},
    confidence:{type:"number"},
    stream_category:{type:"string"},
    moment_type:{type:"string"},
    topic:{type:"string"},
    streamer_mood:{type:"string"},
    energy:{type:"string"},
    speaker_likely:{type:"string"},
    response_intent:{type:"string"},
    conversation_action:{type:"string"},
    specific_reference:{type:"string"},
    reason:{type:"string"},
    memory_updates:{type:"array",items:{type:"string"}},
    running_joke_candidate:{type:"string"},
    urgency:{type:"string"}
  },
  required:[
    "should_reply","confidence","stream_category","moment_type","topic",
    "streamer_mood","energy","speaker_likely","response_intent",
    "conversation_action","specific_reference","reason","memory_updates",
    "running_joke_candidate","urgency"
  ],
  additionalProperties:false
};

const writerSchema={
  type:"object",
  properties:{
    should_send:{type:"boolean"},
    reply:{type:"string"},
    style_note:{type:"string"}
  },
  required:["should_send","reply","style_note"],
  additionalProperties:false
};

const criticSchema={
  type:"object",
  properties:{
    allow:{type:"boolean"},
    grounded_score:{type:"number"},
    specificity_score:{type:"number"},
    naturalness_score:{type:"number"},
    repeat_risk:{type:"number"},
    reason:{type:"string"},
    rewrite_hint:{type:"string"}
  },
  required:[
    "allow","grounded_score","specificity_score",
    "naturalness_score","repeat_risk","reason","rewrite_hint"
  ],
  additionalProperties:false
};

function safeJSON(text){
  try{return JSON.parse(text)}
  catch{throw new Error(`Model returned invalid structured output: ${String(text).slice(0,300)}`)}
}

function compactMemory(memory){
  const m=memory&&typeof memory==="object"?memory:{};
  return {
    facts:Array.isArray(m.facts)?m.facts.slice(-35):[],
    runningJokes:Array.isArray(m.runningJokes)?m.runningJokes.slice(-8):[],
    recentDialogue:Array.isArray(m.recentDialogue)?m.recentDialogue.slice(-24):[],
    currentTopic:String(m.currentTopic||""),
    streamCategory:String(m.streamCategory||"unknown"),
    mood:String(m.mood||"unknown"),
    energy:String(m.energy||"unknown"),
    conversation:m.conversation||{active:false,topic:"",turns:0,lastAt:0}
  };
}

async function runDirector({
  transcript,recentTranscript,frames,memory,audioMetrics,proactiveTurn
}){
  const mem=compactMemory(memory);
  const visualChanges=(frames||[]).map((f,i)=>`frame_${i+1}_change=${f.change||0}`).join(", ");

  const text=`You are the DIRECTOR for a clearly identified AI co-host on a livestream.

Your job is NOT to write the chat message.
Your job is to understand the moment and decide whether speaking would improve it.

STREAMER LABEL: ${STREAMER_NAME}
AI CO-HOST LABEL: ${BOT_NAME}

NEW SPEECH:
${transcript || "(none — this is a proactive check)"}

RECENT SPEECH:
${recentTranscript || "(none)"}

AUDIO ACTIVITY METRICS:
${JSON.stringify(audioMetrics||{})}

VISUAL CHANGE METRICS:
${visualChanges || "(none)"}

PERSISTENT STREAM MEMORY:
${JSON.stringify(mem)}

RECENT AI REPLIES:
${replyHistory.slice(-20).join(" | ") || "(none)"}

PROACTIVE CHECK: ${proactiveTurn ? "YES" : "NO"}

DIRECTOR RULES:
- First infer what kind of stream/moment is actually happening. Never assume gaming.
- It may be Just Chatting, IRL, cars, food, shopping, reactions, music, gaming, sports, tutorials, storytelling, or something else.
- Use ALL supplied frames as a short visual sequence. Compare them rather than treating one screenshot as the whole event.
- Be conservative. Normal sitting, waiting, scrolling, menu browsing, background game audio, or ordinary silence usually means no reply.
- Do not confuse TV/game/video dialogue with the streamer. If the speaker is probably not the streamer, normally stay quiet.
- If there is a direct question, clear joke, opinion, strong reaction, reveal, accomplishment, mistake, surprising visual change, or active conversation, a reply may make sense.
- Existing conversation memory matters. If the streamer is answering the AI's recent question, continue that topic naturally.
- For a proactive check, only start a conversation if you have a SPECIFIC grounded subject from recent memory or the current visual sequence. Never start with generic greetings or filler.
- Long-term memory updates must only include facts the streamer explicitly said or stable topics clearly established. Do not save guesses from an image as facts.
- A running-joke candidate should be empty unless a genuinely reusable joke/reference emerged.
- should_reply=true only when confidence is strong enough that speaking improves the moment.
- Set confidence from 0 to 1.
- response_intent should be a concise label such as react, answer, ask, tease, acknowledge, disagree, continue, clarify, celebrate, observe, or silence.
- conversation_action must be one of: none, start, continue, end.
- urgency should be one of: low, normal, high.
- specific_reference must state the exact thing the response would be about. If you cannot name one, should_reply should normally be false.`;

  const content=[{type:"input_text",text}];

  for(const f of (frames||[]).slice(-3)){
    if(String(f.dataUrl||"").startsWith("data:image/")){
      content.push({
        type:"input_image",
        image_url:f.dataUrl,
        detail:"low"
      });
    }
  }

  const response=await openai.responses.create({
    model:DIRECTOR_MODEL,
    input:[{role:"user",content}],
    text:{
      format:{
        type:"json_schema",
        name:"stream_director",
        schema:directorSchema,
        strict:true
      }
    }
  });

  return safeJSON(response.output_text);
}

async function runWriter({director,transcript,recentTranscript,memory}){
  const mem=compactMemory(memory);

  const response=await openai.responses.create({
    model:WRITER_MODEL,
    input:[{
      role:"user",
      content:`You are the WRITER for a clearly identified AI livestream co-host.

The DIRECTOR already analyzed the moment:
${JSON.stringify(director)}

NEW SPEECH:
${transcript || "(none)"}

RECENT SPEECH:
${recentTranscript || "(none)"}

MEMORY:
${JSON.stringify(mem)}

RECENT SENT REPLIES:
${replyHistory.slice(-25).join(" | ") || "(none)"}

Write only if the director's moment is actually worth speaking on.

STYLE:
- Usually 2-12 words. Never more than one short sentence.
- Sound like casual livestream chat, not a customer-service assistant.
- Specific beats generic. Tie the reply to director.specific_reference.
- Natural lowercase is okay when it fits.
- Light current slang is allowed occasionally: bruh, gang, my boy, twin, ngl, lowkey, fr, cooked, sold, locked in.
- Most replies should use NO slang.
- Never stack slang or force it.
- Vary sentence openings and structures.
- Avoid canned hype, motivational filler, and generic "vibe/energy" language.
- Do not repeat or lightly reword a recent sent reply.
- Do not use the streamer's username/name unless directly necessary; normally use "you".
- Never pretend to be an independent human viewer or claim personal human experiences.
- If a short question naturally continues an existing conversation, that is okay.
- If the director is weak/uncertain or you cannot make a specific reply, set should_send=false and reply="".
`
    }],
    text:{
      format:{
        type:"json_schema",
        name:"stream_writer",
        schema:writerSchema,
        strict:true
      }
    }
  });

  return safeJSON(response.output_text);
}

async function runCritic({director,writer,transcript,memory}){
  const response=await openai.responses.create({
    model:CRITIC_MODEL,
    input:[{
      role:"user",
      content:`You are a strict quality gate for a livestream AI co-host.

DIRECTOR:
${JSON.stringify(director)}

CANDIDATE:
${JSON.stringify(writer)}

CURRENT SPEECH:
${transcript || "(none)"}

RECENT MEMORY / DIALOGUE:
${JSON.stringify(compactMemory(memory))}

RECENT SENT REPLIES:
${replyHistory.slice(-25).join(" | ") || "(none)"}

Block the candidate unless it is:
- grounded in the director's exact moment,
- specific rather than generic,
- short and conversational,
- not repetitive,
- not assistant-like,
- not random hype,
- appropriate to the actual stream context.

Score from 0 to 1. allow=true only when grounded, specificity, and naturalness are all strong and repeat risk is low.
`
    }],
    text:{
      format:{
        type:"json_schema",
        name:"stream_critic",
        schema:criticSchema,
        strict:true
      }
    }
  });

  return safeJSON(response.output_text);
}

function intervalFor(director,memory){
  const active=Boolean(memory?.conversation?.active);
  if(director?.urgency==="high") return 7000;
  if(director?.conversation_action==="continue" || active){
    return MIN_CONVERSATION_INTERVAL_MS;
  }
  return MIN_NORMAL_INTERVAL_MS;
}

function delayFor(director,reply){
  const words=String(reply||"").trim().split(/\s+/).filter(Boolean).length;
  if(director?.urgency==="high"){
    return 700+Math.floor(Math.random()*1400);
  }
  if(director?.conversation_action==="continue"){
    return 1400+Math.floor(Math.random()*2600);
  }
  return 2200+Math.floor(Math.random()*3600)+Math.min(words*80,700);
}

// ---------------- Pages ----------------
app.get("/health",(_req,res)=>res.json({ok:true,version:"5.0.0"}));
app.get("/",(_req,res)=>res.type("html").send(DASHBOARD_HTML));

// ---------------- Kick OAuth ----------------
app.get("/auth/kick/start",(_req,res)=>{
  if(!CLIENT_ID||!CLIENT_SECRET||!REDIRECT_URI){
    return res.status(500).send("Missing Kick OAuth environment variables.");
  }

  const verifier=crypto.randomBytes(48).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const state=crypto.randomBytes(24).toString("base64url");

  setEncryptedCookie(
    res,"bb_oauth",
    {verifier,state,created:Date.now()},
    10*60
  );

  const qs=new URLSearchParams({
    response_type:"code",
    client_id:CLIENT_ID,
    redirect_uri:REDIRECT_URI,
    scope:"user:read channel:read chat:write",
    state,
    code_challenge:challenge,
    code_challenge_method:"S256"
  });

  res.redirect(`https://id.kick.com/oauth/authorize?${qs}`);
});

app.get("/auth/kick/callback",async(req,res)=>{
  try{
    const pending=getEncryptedCookie(req,"bb_oauth");
    if(!pending || String(req.query.state||"")!==pending.state){
      throw new Error("Kick OAuth state check failed.");
    }

    const body=new URLSearchParams({
      grant_type:"authorization_code",
      code:String(req.query.code||""),
      client_id:CLIENT_ID,
      client_secret:CLIENT_SECRET,
      redirect_uri:REDIRECT_URI,
      code_verifier:pending.verifier
    });

    const r=await fetch("https://id.kick.com/oauth/token",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body
    });

    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`Kick token exchange failed: ${JSON.stringify(data)}`);

    setEncryptedCookie(res,"bb_kick_token",{
      ...data,
      expires_at:data.expires_in
        ? Date.now()+Number(data.expires_in)*1000
        : null
    },60*60*24*30);

    clearCookie(res,"bb_oauth");
    res.redirect("/");
  }catch(e){
    res.status(500).send(`<h2>Kick authorization error</h2><pre>${String(e.message||e)}</pre>`);
  }
});

app.get("/api/status",(req,res)=>{
  res.json({
    kickAuthorized:Boolean(getEncryptedCookie(req,"bb_kick_token")?.access_token),
    broadcasterId:broadcasterId(req)||null,
    channelSlug:CHANNEL_SLUG,
    botName:BOT_NAME,
    streamerName:STREAMER_NAME,
    autoSend:AUTO_SEND,
    directorModel:DIRECTOR_MODEL,
    writerModel:WRITER_MODEL,
    criticEnabled:ENABLE_CRITIC,
    realtimeModel:REALTIME_TRANSCRIBE_MODEL
  });
});

// ---------------- Realtime browser transcription ----------------
app.post("/api/realtime-token",express.json(),async(_req,res)=>{
  try{
    const sessionConfig={
      session:{
        type:"transcription",
        audio:{
          input:{
            transcription:{
              model:REALTIME_TRANSCRIBE_MODEL,
              prompt:`Livestream audio. The main streamer is labeled ${STREAMER_NAME}. Accurately transcribe casual speech, names, slang, games, cars, products, and stream conversation.`,
              languages:["en"],
              delay:"low"
            },
            turn_detection:{
              type:"server_vad",
              threshold:0.48,
              prefix_padding_ms:300,
              silence_duration_ms:650
            }
          }
        }
      }
    };

    const r=await fetch("https://api.openai.com/v1/realtime/client_secrets",{
      method:"POST",
      headers:{
        Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type":"application/json",
        "OpenAI-Safety-Identifier":"backendboys-stream-cohost"
      },
      body:JSON.stringify(sessionConfig)
    });

    const data=await r.json().catch(()=>({}));
    if(!r.ok){
      throw new Error(`Realtime token error (${r.status}): ${JSON.stringify(data)}`);
    }

    res.json(data);
  }catch(e){
    res.status(500).json({error:e.message||String(e)});
  }
});

// Fallback bounded transcription if WebRTC is unavailable.
app.post(
  "/api/transcribe-fallback",
  express.raw({
    type:["audio/*","video/webm","application/octet-stream"],
    limit:"25mb"
  }),
  async(req,res)=>{
    let tmp=null;
    try{
      const bytes=Buffer.from(req.body||[]);
      if(bytes.length<1000) return res.json({text:""});

      tmp=path.join(os.tmpdir(),`backendboys-${crypto.randomUUID()}.webm`);
      fs.writeFileSync(tmp,bytes);

      const tx=await openai.audio.transcriptions.create({
        file:fs.createReadStream(tmp),
        model:FALLBACK_TRANSCRIBE_MODEL
      });

      res.json({text:String(tx.text||"").trim()});
    }catch(e){
      res.status(500).json({text:"",error:e.message||String(e)});
    }finally{
      if(tmp){try{fs.unlinkSync(tmp)}catch{}}
    }
  }
);

app.use(express.json({limit:"15mb"}));

app.post("/api/resolve-channel",async(req,res)=>{
  try{
    const t=await getKickToken(req,res);
    const slug=String(req.body?.slug||CHANNEL_SLUG).trim();
    if(!slug) throw new Error("Enter the streamer Kick username.");

    const r=await fetch(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
      {headers:{Authorization:`Bearer ${t.access_token}`,Accept:"application/json"}}
    );

    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`Kick channel lookup failed (${r.status}): ${JSON.stringify(data)}`);

    const item=Array.isArray(data?.data)?data.data[0]:data?.data;
    const id=String(item?.broadcaster_user_id||"");
    if(!id) throw new Error("Kick returned no broadcaster_user_id.");

    setEncryptedCookie(res,"bb_channel",{broadcasterId:id,slug},60*60*24*30);
    res.json({ok:true,broadcasterId:id});
  }catch(e){
    res.status(500).json({ok:false,error:e.message||String(e)});
  }
});

app.post("/api/test",async(req,res)=>{
  try{
    const content=String(req.body?.content||"AI co-host connection test ✅")
      .trim().slice(0,450);
    await sendKick(req,res,content);
    res.json({ok:true});
  }catch(e){
    res.status(500).json({ok:false,error:e.message||String(e)});
  }
});

// ---------------- Advanced brain ----------------
app.post("/api/brain",async(req,res)=>{
  try{
    const transcript=String(req.body?.transcript||"").trim();
    const recentTranscript=String(req.body?.recentTranscript||"").trim();
    const frames=Array.isArray(req.body?.frames)?req.body.frames.slice(-3):[];
    const memory=compactMemory(req.body?.memory);
    const audioMetrics=req.body?.audioMetrics||{};
    const proactiveTick=Boolean(req.body?.proactiveTick);

    const proactiveTurn=
      proactiveTick &&
      !transcript &&
      Date.now()>=nextProactiveAt;

    // Ignore routine proactive ticks until the schedule is actually due.
    if(proactiveTick && !proactiveTurn){
      return res.json({
        action:"skip",
        reason:"proactive timer not due"
      });
    }

    const director=await runDirector({
      transcript,
      recentTranscript,
      frames,
      memory,
      audioMetrics,
      proactiveTurn
    });

    // Schedule next proactive opportunity whether opener succeeds or not,
    // so the app cannot hammer openers every 25 seconds.
    if(proactiveTurn) scheduleNextProactive();

    const confidence=Number(director.confidence||0);
    if(!director.should_reply || confidence<0.76){
      return res.json({
        action:"skip",
        reason:`director stayed quiet (${Math.round(confidence*100)}%)`,
        director
      });
    }

    if(String(director.speaker_likely||"").toLowerCase()==="other" &&
       director.response_intent!=="observe"){
      return res.json({
        action:"skip",
        reason:"director thinks speech is not the streamer",
        director
      });
    }

    const minInterval=intervalFor(director,memory);
    if(Date.now()-lastSentAt<minInterval){
      return res.json({
        action:"skip",
        reason:"dynamic cooldown",
        director
      });
    }

    const writer=await runWriter({
      director,
      transcript,
      recentTranscript,
      memory
    });

    let reply=String(writer.reply||"").replace(/\s+/g," ").trim().slice(0,450);

    if(!writer.should_send || !reply){
      return res.json({
        action:"skip",
        reason:"writer declined",
        director
      });
    }

    if(isRepeat(reply)){
      return res.json({
        action:"skip",
        reason:"hard anti-repeat blocked",
        director
      });
    }

    if(isGenericBottyReply(reply)){
      return res.json({
        action:"skip",
        reason:"generic/botty phrase blocked",
        director
      });
    }

    if(ENABLE_CRITIC){
      const critic=await runCritic({
        director,
        writer:{...writer,reply},
        transcript,
        memory
      });

      if(
        !critic.allow ||
        Number(critic.grounded_score||0)<0.75 ||
        Number(critic.specificity_score||0)<0.70 ||
        Number(critic.naturalness_score||0)<0.70 ||
        Number(critic.repeat_risk||0)>0.45
      ){
        return res.json({
          action:"skip",
          reason:`critic blocked: ${critic.reason}`,
          director,
          critic
        });
      }
    }

    if(!AUTO_SEND){
      return res.json({
        action:"preview",
        reply,
        director
      });
    }

    await new Promise(resolve=>setTimeout(
      resolve,
      delayFor(director,reply)
    ));

    // Re-check spacing after natural delay in case another request sent first.
    if(Date.now()-lastSentAt<Math.min(minInterval,5000)){
      return res.json({
        action:"skip",
        reason:"send race avoided",
        director
      });
    }

    await sendKick(req,res,reply);
    lastSentAt=Date.now();
    rememberReply(reply);

    res.json({
      action:"sent",
      reply,
      director
    });

  }catch(e){
    console.error("Advanced brain error:",e);
    res.status(500).json({error:e.message||String(e)});
  }
});

app.post("/api/send-preview",async(req,res)=>{
  try{
    const reply=String(req.body?.reply||"").replace(/\s+/g," ").trim().slice(0,450);
    if(!reply) throw new Error("No reply supplied.");
    if(isRepeat(reply)) throw new Error("Anti-repeat blocked this reply.");
    if(isGenericBottyReply(reply)) throw new Error("Generic/botty phrase blocked.");

    await sendKick(req,res,reply);
    lastSentAt=Date.now();
    rememberReply(reply);
    res.json({ok:true});
  }catch(e){
    res.status(500).json({ok:false,error:e.message||String(e)});
  }
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`Backendboys Advanced Brain v5 running on port ${PORT}`);
});
