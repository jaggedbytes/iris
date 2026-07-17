# Iris

Iris is a phone-first AI companion for older adults. The current demo proves the Bridge path: a family member or operator can ask Iris to check in by phone, Iris can recall consented conversation continuity, and an explicitly approved message can reach a trusted contact.

## Phone-first Bridge demo

The dashboard starts an outbound Twilio call. Twilio opens a bidirectional Media Stream to the Iris server, which relays G.711 μ-law audio to OpenAI Realtime without application-side transcoding. When the call ends, raw audio and transcript text are discarded. Conversation-derived data is limited to a consent-gated structured summary and durable user-stated memory; required operational audit and outbox records may also be retained.

```text
Operator or trusted contact dashboard
  → Iris server → Twilio outbound call → person’s phone
  ← dashboard timeline and consented call summary
```

The timeline is a privacy boundary: it renders only allowlisted, human-readable event data. It never exposes message bodies, phone numbers, provider identifiers, raw transcripts, or audit metadata.

## Browser voice prototype

The prototype will let a person speak with Iris in the browser before we introduce phone transport. It is intentionally split into two independent applications:

- `server/` — Express + TypeScript. It will mint a short-lived OpenAI Realtime client secret and own persona configuration.
- `frontend/` — Vite + React + TypeScript. It will capture microphone input, establish a WebRTC peer connection, and play Iris’s returned audio.

The browser will never receive `OPENAI_API_KEY`. The intended connection flow is:

```text
Browser → Iris server (short-lived token) → OpenAI Realtime
Browser ─────────────── WebRTC audio + events ─────────────→ OpenAI Realtime
```

The browser WebRTC voice loop and token endpoint are still implemented as the earlier persona experiment. It is not part of the phone-first Bridge demo. The user’s microphone audio and Iris’s returned audio are live-only.

## Planned local development

Prerequisites: Node.js 22+ and an OpenAI API key.

```bash
cd server && npm install && npm run dev
cd frontend && npm install && npm run dev
```

Copy `server/.env.example` to `server/.env` and set `OPENAI_API_KEY`. Do not put the API key in the frontend.

## Local dashboard foundation

The dashboard is protected by `IRIS_ADMIN_TOKEN`; set a long local secret in `server/.env`, then seed the included demo person and trusted contact before starting the server:

```bash
cd server && npm run db:seed && npm run dev
cd frontend && npm run dev
```

Open the frontend and enter `IRIS_ADMIN_TOKEN` to use the operator view. Operators can create an expiring, revocable trusted-contact link.

## Phone-first Bridge smoke test

Set the Twilio and `IRIS_PUBLIC_BASE_URL` values in `server/.env`. The public URL must terminate at this server and be reachable by Twilio over HTTPS/WSS (a tunnel is fine for local development). Ensure the demo person's `phone_e164` is a phone you are authorized to call. Start the server and frontend, sign in as the operator, press **Call now**, answer the phone, and speak with Iris.

The seed grants summary-retention consent for the demo person. To run the full demo:

1. Start the server and frontend, sign in as the operator, and press **Call now**.
2. Answer the authorized demo phone. Confirm that Iris is audible and that the dashboard changes from **Calling…** to **Call in progress**.
3. During the conversation, give Iris one durable, explicitly stated fact. If demonstrating Bridge, ask Iris to send an approved SMS to a trusted contact.
4. Hang up. The dashboard polls while the summary is processing, then shows a recap when it is ready. Check that the timeline contains readable call, summary, and SMS/delivery cards with no private transport data.
5. Create a trusted-contact link with `request_check_in`, open it in a separate session, and select **Ask Iris to check in**. The timeline should attribute the request by the contact’s display name.

If delivery is confirmed, do not retry. If delivery remains uncertain, an operator may use the recovery card after accepting that **Retry SMS** can create a duplicate message by design.

## Repository layout

```text
iris/
├── docs/
│   ├── architecture.md
│   └── voice-prototype.md
├── frontend/                 # browser-only voice client
│   └── src/
├── server/                   # API and persona ownership
│   └── src/
│       └── personas/
└── README.md
```

## Privacy boundary

Raw microphone and phone audio, raw transcripts, message bodies, phone numbers, and provider identifiers are never rendered in the dashboard timeline. Phone transcripts remain in memory only for the active call, then are discarded. Conversation-derived durable storage is limited to consented structured summaries, user-stated facts, named people/context, and unresolved topics; required operational audit and outbox records may also be retained.
