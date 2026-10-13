# Automation Chat

The AI copilot as its own app and container (port **3004**), separate from the manual dashboard (`frontend/`, port 3000).

- Talks to the same backend: API gateway (`/chat/stream`, `/events/stream`) and the chat-agent behind it.
- **Single sign-on:** signing in on the dashboard sets an httpOnly cookie (`insurance_sso`); this app reads it
  (`/api/sso/session`, verified against `/auth/me`) and signs the same user in. Not signed in on the dashboard? You are
  sent to its login page and brought back here.
- Pages the copilot opens or embeds are loaded from the app that serves them: case views and other underwriting pages
  from the Underwriting Workbench (`NEXT_PUBLIC_UNDERWRITING_URL`, see `underwriting-app/README.md`), forms and record
  pages from the dashboard (`NEXT_PUBLIC_PORTAL_URL`). Embedded pages may only message the chat from those two origins.
- It starts with the rest of the stack (`docker compose up -d --build`). Stop it on its own with
  `docker compose stop automation-chat`.
- The dashboard's **Automation** button opens it in a new tab, and says so if the container is not running.

## OpenAI live voice

The **Live Voice Agent** button uses `gpt-realtime-2.1-mini` over WebRTC. Audio travels directly between the browser and OpenAI; the backend creates the session using the unified `/v1/realtime/calls` handshake. No long-lived provider key is returned to the browser. The former `/api/agent-config` endpoint now returns public model metadata only.

Live voice supports English/Urdu, streaming captions, automatic turn detection, interruption while the assistant speaks, mute, stop-speaking, retry, a minimized call bar, and explicit end-call. Use **Show chat** to keep the call active while working in a form. Form/upload requests minimize the overlay automatically. Calls end after 15 minutes; starting another call retains the text chat. HTTPS is required outside localhost. If browser autoplay is blocked, use **Tap to enable audio**.

### Credentials

An OpenAI primary or fallback provider configured in **Platform → LLM Configuration** is sufficient. The backend resolves it without changing the text agent's model. Optionally set these variables on **chat-agent**, through the root `.env`/Compose environment:

```env
# Optional dedicated credential. Keep server-side; never use NEXT_PUBLIC_*.
OPENAI_REALTIME_API_KEY=
# Defaults:
OPENAI_REALTIME_VOICE=cedar
OPENAI_VOICE_TRANSCRIBE_MODEL=gpt-transcribe
```

Credential precedence: dedicated realtime key → server `OPENAI_API_KEY` → registered OpenAI provider. The voice conversation model is pinned to `gpt-realtime-2.1-mini`. Verify access and quota in the configured OpenAI project. Restart/recreate chat-agent after changing its environment.

```bash
docker compose up -d --build chat-agent api-gateway automation-chat
```

### Platform actions and confirmations

The Realtime model has a single `platform_request` tool. It passes requests into the **same chat thread and LangGraph workflow** used by the text UI, preserving backend permissions, guided journeys, clarifications, confirmations, navigation and form/upload handling. Platform requests incur the existing text agent's model usage in addition to Realtime audio usage.

Voice graph requests verify the SSO/bearer session and tenant on the server, and use the verified role rather than a browser-supplied role. Mutation confirmation requires an unambiguous fresh user transcript such as “yes”, “cancel”, “جی ہاں”, or “نہیں”. The model cannot confirm its own action. If captions are unavailable, use the visible chat confirmation buttons. Forms and uploads continue in the chat UI. Interrupting audio does not undo a business action already in progress, and retries do not automatically replay actions.

The microphone dictation button also uses authenticated OpenAI transcription via `/api/stt`; live voice no longer depends on Deepgram. The legacy standalone `/api/tts` handler is not used by the live-voice UI.

### Verification

```bash
docker compose exec -T automation-chat npm run typecheck
docker compose exec -T automation-chat node --test tests/realtime.test.cjs tests/voice-proxy.test.cjs
docker compose exec -T chat-agent python test_voice.py
docker build --target builder -t insurance-ai-automation-chat-voice-check automation-chat
```

Tests cover credential/session boundaries, tenant checks, server-derived roles, safe confirmation, duplicate tool delivery, delayed captions, audio interruption, microphone cleanup, and call closure during pending work. Live-provider smoke testing should separately verify WebRTC audio and captions with the actual configured account. Real microphone quality, noise handling, and Urdu pronunciation should be checked on the browsers and devices used by staff.

Reference: [OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc).
