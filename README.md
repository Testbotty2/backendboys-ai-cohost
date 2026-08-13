# BackendBoys AI Co-host — Sonnet 5 + OpenAI Rework 2.2

A simplified livestream co-host dashboard using Claude Sonnet 5 or OpenAI for the brain, OpenAI Realtime for transcription, current-stream-only chat context, smoother screen capture, a per-stream cost guard, and up to 10 OAuth-connected Kick co-host account slots.

## Main setup

1. Set a strong `DASHBOARD_PASSWORD`. The dashboard and `/api/*` controls now require a password login.
2. Add your `ANTHROPIC_API_KEY` for Claude Sonnet 5. In the Claude Console, open **Settings → API keys**, create a key, then save it as the `ANTHROPIC_API_KEY` environment variable.
3. Add `OPENAI_API_KEY` for Realtime transcription and the optional OpenAI brain.
4. Configure your Kick developer app, callback URL, and credentials.
5. Run `npm install` and `npm start`.
6. Sign in to the dashboard, add a Kick account, resolve the streamer, subscribe current-stream chat, and start stream capture.

For hosted deployments such as Render, set secrets in the host's Environment Variables panel instead of committing or sharing a populated `.env` file.

## Dashboard

- Cleaner 4-section dashboard: Accounts & Stream, Brain, Live Watch, Activity.
- Up to 10 Kick OAuth-connected co-host accounts.
- One selected active sender at a time.
- Claude Sonnet 5 / OpenAI brain selector.
- Human Reaction slider from 0–100%.
- Per-stream budget meter and automatic vision throttling near the configured limit.
- Password-protected dashboard with an HttpOnly session cookie.

## Stream viewing / vision

The visible preview can run at 30 or 60 FPS. Vision frames are sampled locally and only the newest recent frames are attached when the brain runs; the app does not send every preview frame to the model.

Current controls:

- Preview: 30 / 60 FPS
- Vision sampling: 1 / 2 / 4 / 6 / 8 FPS
- Vision width: 720 / 960 / 1280 / 1600 px
- Frame burst: 1–5 recent frames per brain decision
- Default gaming setup: 60 FPS preview, 6 FPS local sampling, 1280 px, 4-frame burst

## Realtime transcript reliability

Realtime transcription completion events can arrive out of order across speech turns. The dashboard now tracks turns by OpenAI `item_id` and audio start order, waits briefly for an earlier turn when needed, and coalesces a small batch of the newest completed speech if the brain falls behind. Old queued speech is discarded instead of being allowed to create delayed replies long after the streamer has moved on.

## Accounts

Click **+ Add Account** to create a slot and connect it through Kick OAuth. Repeat for up to 10 accounts. Select **Use** on the account that should send chat messages. Account tokens are kept separately in encrypted server-side state.

## Existing unrelated files

Existing unrelated files in the archive were left unchanged by this reliability/security update.
