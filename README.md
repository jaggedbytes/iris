# Iris

Iris is a phone-first AI companion for older adults. The current demo proves Bridge and Shield: a family member or operator can ask Iris to check in by phone, Iris can recall consented conversation continuity, and Iris can offer a calm scam-safety pause with an explicitly approved, privacy-safe trusted-contact alert.

## Phone-first Bridge + Shield demo

The dashboard starts an outbound Twilio call. Twilio opens a bidirectional Media Stream to the Iris server, which relays G.711 μ-law audio to OpenAI Realtime without application-side transcoding. Raw audio is never persisted. Transcript text is held only in memory for consent-gated summary extraction after the call, then discarded—it is never written to SQLite. Conversation-derived durable data is limited to a consented structured summary and user-stated memory; required operational audit and outbox records may also be retained.

```text
Operator or trusted contact dashboard
  → Iris server → Twilio outbound call → person’s phone
  ← dashboard timeline and consented call summary
```

The timeline is a privacy boundary: it renders only allowlisted, human-readable event data. It never exposes message bodies, phone numbers, provider identifiers, raw transcripts, or audit metadata.

## Browser voice prototype

The browser loop remains from the earlier persona experiment. It is intentionally separate from the phone-first demo:

- `server/` — Express + TypeScript. It mints a short-lived OpenAI Realtime client secret and owns persona configuration.
- `frontend/` — Vite + React + TypeScript. It captures microphone input, establishes a WebRTC peer connection, and plays Iris’s returned audio.

The browser will never receive `OPENAI_API_KEY`. The intended connection flow is:

```text
Browser → Iris server (short-lived token) → OpenAI Realtime
Browser ─────────────── WebRTC audio + events ─────────────→ OpenAI Realtime
```

The browser WebRTC voice loop and token endpoint are still implemented as the earlier persona experiment. It is not part of the phone-first Bridge demo. The user’s microphone audio and Iris’s returned audio are live-only.

## Hosted judge demo (Railway)

The judge-facing demo should be a private, hosted instance operated by you; do
not ask judges to configure Twilio or run a local server. The seeded local
workflow remains the reproducible fallback.

This repository includes a single-service Docker deployment. In Railway:

1. Deploy from this repository and generate one public HTTPS domain.
2. Attach a persistent volume at `/app/data`. The image pins `IRIS_DATABASE_PATH=/app/data/iris.sqlite`; keep the service at one replica. SQLite and active phone sessions are intentionally single-process in this prototype.
3. Set `IRIS_PUBLIC_BASE_URL=https://your-public-domain` and `FRONTEND_ORIGIN=https://your-public-domain` to the same Railway domain, plus the existing OpenAI, Twilio, dashboard-token, and demo-person variables. Production startup fails if `FRONTEND_ORIGIN` is omitted, preventing copied opt-in links from pointing to localhost.
4. Configure Twilio’s Voice webhooks and the Messaging Service inbound-message webhook at `https://your-public-domain/api/messages/inbound`. From the Railway shell, run `npm run db:seed:prod` only when you want the demo fixture reset; the production image intentionally contains compiled `dist/` files rather than TypeScript source.

SMS enrollment and confirmation messages depend on a live Twilio Messaging Service
and registered A2P 10DLC campaign. Before that is live, a confirmation may fail or
require operator recovery; that is external carrier configuration, not an
enrollment-data failure.

The container serves the production dashboard and public SPA routes such as `/opt-in` from Express. `/api/*`, Twilio webhooks, and the Media Stream endpoint remain server routes rather than SPA fallbacks.

The hosted opt-in form uses `IRIS_PRIVACY_URL` and `IRIS_TERMS_URL`, which default to Iris’s public legal pages. Keep those URLs public and HTTPS; they are rendered directly to invited contacts.

## Local development

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

## Phone-first Bridge + Shield smoke test

Set the Twilio and `IRIS_PUBLIC_BASE_URL` values in `server/.env`. The public URL must terminate at this server and be reachable by Twilio over HTTPS/WSS (a tunnel is fine for local development).

- `IRIS_DEMO_PHONE_E164` is the authorized destination phone that receives Iris’s call.
- `TWILIO_PHONE_NUMBER` is Iris’s Twilio sender/from-number. It is not the demo destination.
- `TWILIO_MESSAGING_SERVICE_SID` is required for every Iris SMS. Configure Twilio Advanced Opt-Out on that Messaging Service with the same HELP response as `IRIS_SMS_HELP_TEXT` (shown on the public opt-in form).
- `IRIS_FAREWELL_CLOSE_TIMEOUT_MS` is optional and defaults to `8000`. It bounds only a missing completion event after a tool-driven goodbye; it is not an idle-call timeout.

Set the destination before running `npm run db:seed`. Start the server and frontend, sign in as the operator, press **Call now**, answer the phone, and speak with Iris.

The seed grants summary-retention consent for the demo person. To run the full demo:

1. Start the server and frontend, sign in as the operator, and press **Call now**. Answer the authorized demo phone; Iris should be audible and the dashboard should move from **Calling…** to **Call in progress**.
2. In the first call, state one durable, non-sensitive fact—for example, “I enjoy gardening.” If demonstrating Bridge, ask Iris to send an approved SMS to a trusted contact.
3. For Shield, describe an observable scenario such as: “Someone claiming to be my bank says I need to buy gift cards right now and read them a passcode.” Iris should recommend a pause and using a known official number. After Iris names the selected contact and reads the exact fixed check-in alert, give direct approval. The timeline should show only **Iris offered a safety pause** and **Iris asked Evelyn Carter to check in**—never the scenario or assessment.
4. Say a clear goodbye such as “Goodbye, Iris.” Iris should offer a brief farewell and end the call. The dashboard polls while the summary is processing, then shows only a recap and safe timeline cards.
5. Place a second call. With active consent and a successful first extraction, Iris may offer one gentle gardening-related opener. This is an invitation, not a claim of certainty; do not expect it if the first call had insufficient signal or ASR captured the fact poorly.
6. In a separate short call, hang up the handset normally without saying goodbye. The existing Twilio disconnect path still finalizes the call; `end_call` is additive, not required for every demo.
7. Create a trusted-contact link with `request_check_in` and `view_events`, open it in a separate session, and select **Ask Iris to check in**. The timeline should attribute the request by the contact’s display name and may show the two generic Shield cards.
8. Check that no recap card or timeline payload exposes a recall anchor, raw transcript, SMS body, phone number, provider identifier, Shield scenario, or red-flag label.
9. For the enrollment/compliance check, create an opt-in link from the operator contact card, submit the exact drafted mobile number and checkbox at `/opt-in`, and confirm the operator sees the contact as **SMS: opted in** with confirmation status. In Twilio’s Messaging Service test setup, reply **STOP** from that number; the inbound webhook should change every matching Iris contact to **SMS: opted out**. Reply **HELP** to verify Twilio’s configured help response. Replying **START** does not restore Iris eligibility; use a new web opt-in link.

Twilio accepting an SMS is not proof of delivery. US long-code delivery may require A2P 10DLC brand/campaign registration, which is external to Iris. Every production body begins with one `Iris:` prefix and ends with `Reply HELP for help. Reply STOP to opt out.`; the Messaging Service must be configured with matching Advanced Opt-Out behavior. ASR can also misrecognize names or short utterances, so use an ordinary durable fact for the recall demonstration. If delivery is confirmed, do not retry. If delivery remains uncertain, an operator may use the recovery card after accepting that **Retry SMS** can create a duplicate message by design.

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

Raw microphone and phone audio, raw transcripts, message bodies, phone numbers, and provider identifiers are never rendered in the dashboard timeline. Phone transcripts are never persisted; they remain in memory through consent-gated summary extraction after the call, then are discarded. Conversation-derived durable storage is limited to consented structured summaries, user-stated facts, named people/context, unresolved topics, and recall anchors; the dashboard receives only recap text. Required operational audit and outbox records may also be retained.
