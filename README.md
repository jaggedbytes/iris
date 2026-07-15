# Iris

Iris is a phone-first AI companion for older adults. This first milestone tests the most important product question: can an Iris conversation feel warm, calm, and human?

## Voice prototype

The prototype will let a person speak with Iris in the browser before we introduce phone transport. It is intentionally split into two independent applications:

- `server/` — Express + TypeScript. It will mint a short-lived OpenAI Realtime client secret and own persona configuration.
- `frontend/` — Vite + React + TypeScript. It will capture microphone input, establish a WebRTC peer connection, and play Iris’s returned audio.

The browser will never receive `OPENAI_API_KEY`. The intended connection flow is:

```text
Browser → Iris server (short-lived token) → OpenAI Realtime
Browser ─────────────── WebRTC audio + events ─────────────→ OpenAI Realtime
```

The browser WebRTC voice loop and token endpoint are implemented. The user’s microphone audio and Iris’s returned audio are live-only; this prototype does not record or persist them.

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

Open the frontend and enter `IRIS_ADMIN_TOKEN` to use the operator view. Operators can create an expiring, revocable trusted-contact link. The dashboard currently shows the shared data foundation only; **Call now** remains disabled until the outbound-phone checkpoint.

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

## Privacy boundary for this milestone

This browser experiment should not record or persist microphone audio, call transcripts, or conversations. It exists solely to evaluate conversation quality. Later persistence must be limited to consented structured summaries.
