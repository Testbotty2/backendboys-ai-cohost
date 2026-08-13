# Rework 2.0 notes

- Dashboard reduced to four main sections.
- Added 10 Kick OAuth account slots with one active sender at a time.
- Replaced the old low-rate vision sampling with a smooth 30/60 FPS preview and configurable 1–4 FPS AI vision sampling.
- Increased vision frame size from the old 512px sampling to configurable 720/960/1280px.
- Brain can receive a burst of the newest 1–3 sampled frames.
- Sonnet 5 + OpenAI provider selection, Realtime transcription, Human Reaction threshold, current-stream-only chat, and context reset logic remain.

## 2.2 reliability/security fixes
- `DASHBOARD_PASSWORD` now protects the dashboard and `/api/*` controls with an HttpOnly session cookie.
- `/health`, the Kick webhook receiver, and the Kick OAuth callback remain reachable as required.
- Realtime transcription now reconciles turns by `item_id`/audio start order instead of trusting completion-event arrival order.
- When the AI falls behind, pending completed speech turns are coalesced into the newest short batch and stale backlog is discarded instead of replying to old stream audio.

