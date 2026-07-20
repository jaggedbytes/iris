# Iris

Iris is a phone-first AI companion for older adults. The current demo proves Bridge and Shield: an operator or trusted contact can ask Iris to check in by phone, Iris can recall consented conversation continuity, and Iris can offer a calm scam-safety pause with an explicitly approved, privacy-safe trusted-contact alert.

## Phone-first Bridge + Shield demo

The dashboard starts an outbound Twilio call. Twilio opens a bidirectional Media Stream to the Iris server, which relays audio to OpenAI Realtime without application-side transcoding. Raw audio is never persisted. Transcript text is held only in memory for consent-gated summary extraction after the call, then discarded—it is never written to SQLite.

Private continuity requires active summary-retention consent. A separately consented shared care recap can show a concise update, including explicitly discussed health-related concerns and clearly attributed Iris guidance, to the operator and trusted contacts with summary access. It never exposes raw audio or a full transcript. It does not add a diagnosis, professional conclusion, or guidance Iris did not actually say. Required operational audit and outbox records may also be retained.

```text
Operator or trusted contact dashboard
  → Iris server → Twilio outbound call → person’s phone
  ← dashboard timeline and consented call summary
```

The timeline is a privacy boundary: it renders only allowlisted, human-readable event data. It never exposes message bodies, phone numbers, provider identifiers, raw transcripts, or audit metadata.

## Hosted judge demo (Railway)

The judge-facing demo should be a private, hosted instance operated by you; do
not ask judges to configure Twilio or run a local server. The seeded local
workflow remains the reproducible fallback.

Open the hosted site (for example your Railway public URL), enter `IRIS_ADMIN_TOKEN` on the access screen, and use the operator dashboard. That is the Bridge + Shield demo—there is no browser microphone voice loop.

This repository includes a single-service Docker deployment. In Railway:

1. Deploy from this repository and generate one public HTTPS domain.
2. Attach a persistent volume at `/app/data`. The image pins `IRIS_DATABASE_PATH=/app/data/iris.sqlite`; keep the service at one replica. SQLite and active phone sessions are intentionally single-process in this prototype.
3. Set `IRIS_PUBLIC_BASE_URL=https://your-public-domain` and `FRONTEND_ORIGIN=https://your-public-domain` to the same Railway domain. Also set the OpenAI key and safety identifier, `IRIS_ADMIN_TOKEN`, the Twilio Voice and Messaging Service credentials, `IRIS_DEMO_PHONE_E164`, and the SMS/legal settings from [`server/.env.example`](server/.env.example). Production startup fails if `FRONTEND_ORIGIN` is omitted, preventing copied opt-in links from pointing to localhost.
4. Configure the Twilio Messaging Service inbound-message webhook at `https://your-public-domain/api/messages/inbound`. Iris supplies its Voice TwiML and status-callback URLs with each outbound call, so no console-level Voice webhook is required for this demo. From the Railway shell, run `npm run db:seed:prod` only when you want the demo fixture reset; the production image intentionally contains compiled `dist/` files rather than TypeScript source.

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

Open the frontend and enter `IRIS_ADMIN_TOKEN` to use the operator view. Operators can add people and trusted contacts, create expiring revocable dashboard links, and create one-time SMS opt-in links.

## Phone-first Bridge + Shield smoke test

Set the Twilio and `IRIS_PUBLIC_BASE_URL` values in `server/.env`. The public URL must terminate at this server and be reachable by Twilio over HTTPS/WSS (a tunnel is fine for local development).

- `IRIS_DEMO_PHONE_E164` is the authorized destination phone that receives Iris’s call.
- `TWILIO_PHONE_NUMBER` is Iris’s Twilio sender/from-number. It is not the demo destination.
- `TWILIO_MESSAGING_SERVICE_SID` is required for every Iris SMS. Configure Twilio Advanced Opt-Out on that Messaging Service with the same HELP response as `IRIS_SMS_HELP_TEXT` (shown on the public opt-in form).
- `IRIS_FAREWELL_CLOSE_TIMEOUT_MS` is optional and defaults to `8000`. It bounds only a missing completion event after a tool-driven goodbye; it is not an idle-call timeout.

Set the destination before running `npm run db:seed`. Start the server and frontend, sign in as the operator, press **Call now**, answer the phone, and speak with Iris.

The seed grants both private-memory and shared-care-recap consent for the demo person. Its seeded trusted contact is deliberately non-routable but explicitly opted in for automated tests. For a live Bridge or Shield SMS, add a trusted contact with a mobile number you control and complete the public web opt-in first. To run the full demo:

1. Start the server and frontend, sign in as the operator, and press **Call now**. Answer the authorized demo phone; Iris should be audible and the dashboard should move from **Calling…** to **Call in progress**.
2. In the first call, share a meaningful but non-sensitive update—for example, “I enjoyed watching family videos of my granddaughter’s dance recital.” The dashboard should refresh with a shared care recap after processing. If demonstrating Bridge, ask Iris to send a specific message to the opted-in trusted contact, then give clear spoken approval after Iris reads the recipient and exact final text.
3. For Shield, describe an observable scenario such as: “Someone claiming to be my bank says I need to buy gift cards right now and read them a passcode.” Iris should recommend a pause and using a known official number. After Iris names the selected contact and reads the exact fixed check-in alert, give direct approval. The timeline should show only **Iris offered a safety pause** and **Iris asked [contact] to check in**—never the scenario or assessment.
4. After a little back-and-forth, say a natural closing such as “Goodbye, Iris” or “I should get going.” Iris should offer a brief farewell and end the call. An early or ambiguous goodbye may prompt a short confirmation to guard against background noise. The dashboard polls while the summary is processing, then shows the shared recap and safe timeline cards.
5. Place a second call. With active consent and a successful first extraction, Iris may offer one gentle opener based on the earlier conversation. This is an invitation, not a claim of certainty; do not expect it if the first call had insufficient signal or ASR captured the fact poorly.
6. In a separate short call, hang up the handset normally without saying goodbye. The existing Twilio disconnect path still finalizes the call; `end_call` is additive, not required for every demo.
7. Create a trusted-contact link with `request_check_in` and `view_events`, open it in a separate session, and select **Ask Iris to check in**. The timeline should attribute the request by the contact’s display name and may show the two generic Shield cards.
8. Check that no recap card or timeline payload exposes a recall anchor, raw transcript, SMS body, phone number, provider identifier, Shield scenario, or red-flag label.
9. For the enrollment/compliance check, create an opt-in link from the operator contact card, submit the exact drafted mobile number and checkbox at `/opt-in`, and confirm the operator sees the contact as **SMS: opted in** with confirmation status. In Twilio’s Messaging Service test setup, reply **STOP** from that number; the inbound webhook should change every matching Iris contact to **SMS: opted out**. Reply **HELP** to verify Twilio’s configured help response. Replying **START** does not restore Iris eligibility; use a new web opt-in link.

Twilio accepting an SMS is not proof of delivery. US long-code delivery may require A2P 10DLC brand/campaign registration, which is external to Iris. Every production body begins with one `Iris:` prefix and ends with `Reply HELP for help. Reply STOP to opt out.`; the Messaging Service must be configured with matching Advanced Opt-Out behavior. ASR can also misrecognize names or short utterances, so use an ordinary durable fact for the recall demonstration. If delivery is confirmed, do not retry. If delivery remains uncertain, an operator may use the recovery card after accepting that **Retry SMS** can create a duplicate message by design.

## Repository layout

```text
iris/
├── docs/
│   └── architecture.md
├── frontend/                 # dashboard and public SMS opt-in page
│   └── src/
├── server/                   # API, telephony, and persona ownership
│   └── src/
│       └── personas/
└── README.md
```

## Privacy boundary

Raw phone audio, raw transcripts, message bodies, phone numbers, and provider identifiers are never rendered in the dashboard timeline. Phone transcripts are never persisted; they remain in memory through consent-gated summary extraction after the call, then are discarded. Conversation-derived durable storage is limited to consented structured summaries, user-stated facts, named people/context, unresolved topics, and recall anchors. The dashboard receives only the separately consented shared care recap, including explicitly discussed health-related concerns and clearly attributed Iris suggestions; private memory fields and recall anchors never reach the dashboard. Required operational audit and outbox records may also be retained.
