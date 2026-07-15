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

This repository currently contains the project skeleton only. The token endpoint and WebRTC connection are the next implementation milestone.

## Planned local development

Prerequisites: Node.js 22+ and an OpenAI API key.

```bash
cd server && npm install && npm run dev
cd frontend && npm install && npm run dev
```

Copy `server/.env.example` to `server/.env` before implementing the Realtime token route. Do not put the API key in the frontend.

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

## Next milestone

1. Implement `GET /api/realtime/token` in the server using `OPENAI_API_KEY`.
2. Implement the frontend WebRTC connection and microphone lifecycle.
3. Add a lightweight transcript/status panel for persona evaluation.
4. Iterate on `server/src/personas/iris-v1.ts` using a repeatable test script.
