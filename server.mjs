/* =========================================================
   JUNIORS AI CHAT v10.5 — CYBERPUNK HUD COMMAND CENTER
   ========================================================= */
:root {
  --bg0: #020408;
  --bg1: #050b14;
  --bg2: #091220;
  --panel: rgba(8, 20, 34, 0.85);
  --line: #12355b;
  --line-glow: #00e1ff;
  --cyan: #00f0ff;
  --neon-green: #00ff66;
  --blue: #0066ff;
  --purple: #8a2be2;
  --text: #f0f8ff;
  --muted: #64829f;
  --danger: #ff2a6d;
  --warning: #ffb703;
  --glass: rgba(10, 25, 45, 0.65);
  --shadow-hud: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(0, 240, 255, 0.08);
}

body {
  margin: 0;
  color: var(--text);
  font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: 
    radial-gradient(circle at 15% -10%, rgba(0, 240, 255, 0.12), transparent 40%),
    radial-gradient(circle at 85% 10%, rgba(138, 43, 226, 0.1), transparent 35%),
    linear-gradient(180deg, var(--bg0) 0%, #030710 100%);
  min-height: 100vh;
}

/* Cybernetic Grid Overlay */
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

/* Header HUD Styling */
header {
  position: relative;
  background: var(--glass) !important;
  backdrop-filter: blur(16px);
  border: 1px solid var(--line) !important;
  border-radius: 20px !important;
  box-shadow: var(--shadow-hud);
  padding: 22px !important;
}

header::before {
  content: "";
  position: absolute;
  top: -1px; left: 30px; right: 30px; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cyan), transparent);
}

h1 {
  font-weight: 900;
  letter-spacing: -0.04em;
  background: linear-gradient(135deg, #ffffff 30%, var(--cyan) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

/* Glassmorphism Cards */
.card {
  background: var(--glass) !important;
  backdrop-filter: blur(14px);
  border: 1px solid var(--line) !important;
  border-radius: 18px !important;
  box-shadow: var(--shadow-hud);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.card:hover {
  border-color: rgba(0, 240, 255, 0.4) !important;
  box-shadow: 0 20px 70px rgba(0, 0, 0, 0.7), 0 0 40px rgba(0, 240, 255, 0.15);
}

/* Cyber Badges & Chips */
.neoChip {
  background: rgba(0, 240, 255, 0.06) !important;
  border: 1px solid rgba(0, 240, 255, 0.2) !important;
  color: var(--cyan) !important;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px !important;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.neoChip.hot {
  background: rgba(0, 255, 102, 0.1) !important;
  border-color: var(--neon-green) !important;
  color: var(--neon-green) !important;
  box-shadow: 0 0 12px rgba(0, 255, 102, 0.2);
}

/* Futuristic Control Tabs */
.controlTabs {
  background: rgba(3, 10, 20, 0.85) !important;
  backdrop-filter: blur(18px);
  border: 1px solid var(--line) !important;
  border-radius: 16px !important;
}

.controlTab {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--muted) !important;
  font-weight: 800 !important;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-size: 11px !important;
  transition: all 0.2s ease;
}

.controlTab.active {
  background: linear-gradient(135deg, var(--blue), var(--cyan)) !important;
  color: #000 !important;
  border-color: var(--cyan) !important;
  box-shadow: 0 0 20px rgba(0, 240, 255, 0.4);
}

/* Glowing Account Cards */
.accountCard {
  background: linear-gradient(180deg, rgba(6, 18, 32, 0.9), rgba(2, 8, 16, 0.95)) !important;
  border: 1px solid var(--line) !important;
  border-radius: 16px !important;
}

.accountCard.connected {
  border-color: var(--cyan) !important;
  box-shadow: inset 0 0 20px rgba(0, 240, 255, 0.08), 0 0 25px rgba(0, 240, 255, 0.1);
}

.accountCard.enabled::before {
  background: linear-gradient(180deg, var(--cyan), var(--neon-green)) !important;
  box-shadow: 0 0 15px var(--cyan);
}

/* Interactive Glowing Buttons */
button, .btn {
  background: linear-gradient(180deg, rgba(12, 30, 50, 0.8), rgba(5, 15, 28, 0.9)) !important;
  border: 1px solid var(--line) !important;
  color: var(--text) !important;
  font-weight: 750 !important;
  border-radius: 10px !important;
  transition: all 0.15s ease !important;
}

button:hover:not(:disabled) {
  border-color: var(--cyan) !important;
  box-shadow: 0 0 18px rgba(0, 240, 255, 0.25);
  transform: translateY(-1px);
}

.primary {
  background: linear-gradient(135deg, var(--cyan), #0099ff) !important;
  color: #020812 !important;
  border-color: var(--cyan) !important;
  font-weight: 900 !important;
  box-shadow: 0 0 20px rgba(0, 240, 255, 0.3) !important;
}

.primary:hover:not(:disabled) {
  box-shadow: 0 0 30px rgba(0, 240, 255, 0.5) !important;
}

/* Live Waveform Signal Visualizer */
.waveform.live i {
  background: linear-gradient(180deg, var(--cyan), var(--neon-green)) !important;
  box-shadow: 0 0 10px var(--cyan);
}

/* Terminal & Brain Code Blocks */
pre, .brain, .reply {
  background: rgba(1, 5, 12, 0.9) !important;
  border: 1px solid var(--line) !important;
  color: #a0ecff !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
  border-radius: 12px !important;
}

.reply {
  border-color: rgba(0, 240, 255, 0.3) !important;
  color: #ffffff !important;
  font-size: 22px !important;
  text-shadow: 0 0 15px rgba(0, 240, 255, 0.2);
}
