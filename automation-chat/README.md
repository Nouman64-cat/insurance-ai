# Automation Chat

The AI copilot as its own app and container (port **3004**), separate from the manual dashboard (`frontend/`, port 3000).

- Talks to the same backend: API gateway (`/chat/stream`, `/events/stream`) and the chat-agent behind it.
- **Single sign-on:** signing in on the dashboard sets an httpOnly cookie (`insurance_sso`); this app reads it
  (`/api/sso/session`, verified against `/auth/me`) and signs the same user in. Not signed in on the dashboard? You are
  sent to its login page and brought back here.
- Pages the copilot opens or embeds (cases, forms) are dashboard pages, loaded from `NEXT_PUBLIC_PORTAL_URL`.
- It is **optional and does not start with the rest of the stack** (compose profile `automation`). Start it on purpose:
  `docker compose up -d automation-chat`, stop it with `docker compose stop automation-chat`.
- The dashboard's **Automation** button opens it in a new tab, and says so if the container is not running.
