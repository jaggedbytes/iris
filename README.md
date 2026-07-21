# Iris

**Iris is a phone-first AI companion for aging parents and the families who worry about them.** A caregiver sends Iris to call their loved one on the phone they already own — no app, nothing to install for the older adult. Iris has a warm, natural conversation, keeps the family in the loop, and offers a calm second opinion when a call feels off.

This demo proves two things Iris can do on a call:

- **Bridge**: Iris can reopen a prior conversation thread with one gentle invitation, and can pass a message to a trusted contact after the person's spoken approval.
- **Shield**: when the person describes scam pressure (urgency, gift cards, sworn secrecy), Iris offers a safety pause, steers them away, and, with spoken approval, texts a trusted contact to check in.

Everything the family sees lives in a shared dashboard: recaps of recent calls, a timeline of what Iris has done, and shared notes. Privacy is the foundation. Raw audio and transcripts are never stored, and the dashboard only ever shows allowlisted, human-readable events.

---

## For judges

A hosted demo instance is live — **you don't need to configure Twilio or run anything locally.** The demo URL and operator access token are in the Devpost submission's testing field.

1. Open the demo URL and enter the access token on the login screen to reach the operator dashboard.
2. To place a live call, add yourself as a new person with your own phone number (E.164), turn on **Private memory** and **Shared care recap** (attest and save), then press **Call now**. Iris will ring your phone.
3. Have a short conversation. On a second call, Iris may offer one gentle continuity opener if the first call had enough signal.
4. Try **Bridge** and **Shield**. Iris asks for spoken approval before any text. For a real SMS attempt, add a trusted contact with a mobile number you control, complete the public `/opt-in` form first, then ask Iris to message or alert that contact.

**Please note:**
- The demo runs on a small prepaid balance (~$20 across Twilio Voice and OpenAI Realtime), so brief calls are appreciated. If a call won't connect, the balance may be spent (happy to top it up on request).
- **Carrier SMS delivery is not live yet.** Iris texts depend on Twilio A2P 10DLC registration (US carrier approval for business messaging), which is still pending. The consent-and-send path is built and tested. You'll see Iris request spoken approval and lifecycle events on the dashboard but final delivery to the handset is blocked. When Twilio accepts the API send and the carrier later rejects it, activity may show provider acceptance followed by a delivery update such as undelivered; other failure or recovery states are also possible. That is expected until A2P clears.

**What you can fully verify today:** a live phone conversation with Iris; continuity across calls when private-memory consent is on; Bridge and Shield spoken-consent flows; the public web SMS opt-in path; a consented shared care recap on the dashboard when shared-care consent is on; the scoped trusted-contact view via an expiring magic link; and the privacy boundaries.

---

## How Codex and GPT-5.6 were used

**Iris was built with Codex, with me directing and reviewing.** The working rhythm was consistent throughout: I made the product and architecture decisions, brought plans to Codex, and reviewed every change as Codex implemented it.

- **Validating the idea first.** The riskiest assumption was whether the voice would feel human enough to build a product around. Before any phone infrastructure, I used Codex to spin up a quick browser test of OpenAI's Realtime model so I could hear it. That confirmed the voice, and the rest of the plan grew from there.
- **Plan Mode for shaping.** I brought loose user stories to Codex's Plan Mode and worked them into a concrete, incremental build plan, then had Codex implement it step by step while I reviewed the code, which kept me shaping the architecture rather than chasing it.
- **Getting the hard integrations right.** Codex checked OpenAI's own documentation to implement the current secure patterns (e.g. keeping secret keys server-side, and wiring the Twilio Media Stream into Realtime) then drove the tight write-test-build loops that carried the project to 90+ passing tests.

**GPT-5.6 does the deliberate reasoning** in two places, both on the `gpt-5.6-terra` tier (the balance of quality and cost that fits this everyday work):

- **Consented recaps.** When a call ends and `summary_retention` consent is active, the in-memory transcript is passed once to GPT-5.6 for structured extraction: durable facts, named people and context, unresolved topics, a recap, and an optional recall anchor. With separately active `care_summary_sharing` consent, the same pass also produces the dashboard-only shared care recap. The transcript is then discarded.
- **Shield risk assessment.** During a Shield pause, only the Realtime-provided situation summary is sent to `gpt-5.6-terra` with `store: false`, then both input and output are discarded locally. A pause persists only an empty `shield.pause_offered` event.

The live voice loop itself runs on **OpenAI Realtime**, bridged to the phone network by Twilio.

---

## How it works

The dashboard starts an outbound Twilio call. Twilio opens a bidirectional G.711 µ-law Media Stream to the Iris Express server, which relays audio to OpenAI Realtime with no application-side transcoding. A single `CallSession` owns each call end to end — the connection, the in-memory conversation, interruptions, and a clean shutdown — so features never touch raw provider events. Iris's persona and safety boundaries live in versioned source (`iris-v1.ts`) so they stay reviewable and testable.

```text
Operator or trusted-contact dashboard
  → Iris server → Twilio outbound call → person's phone
  ← call threads, timeline activity, and care-circle notes
```

**Roles.** An operator (admin, usually a lead caregiver) manages several people, each with their own care circle of trusted contacts. A trusted contact can belong to more than one person's circle. The operator sets up each person and invites their contacts. After that, the operator or a trusted contact can start a call.

**The dashboard** is organized into **Home**, **Calls**, and **Updates**. **Calls** expands each recent call into its own thread: the consented recap, call-linked lifecycle and SMS events, and notes about that call (`/calls?call=<call-id>` keeps the same thread open across refresh). **Updates** holds the operator **Messages** recovery queue plus **Recent activity** for unlinked person-level events. Call-linked events appear only in their own thread, never duplicated in a global feed.

**Care-circle notes** are deliberately shared dashboard updates. On Home, the Notes card shows the newest Iris call and notes attached to that call; the Home form creates a note on that same call. With both `care_notes` and `view_summaries`, an expanded call on **Calls** can also add notes to that thread. Older call notes stay thread-only. Authors may edit or soft-delete only their own notes; attribution survives contact deletion. Notes never become Iris memory, Bridge context, or phone-session instructions.

**Call completion.** Outbound calls use Twilio Answering Machine Detection. Iris opens the Media Stream only on a human pickup, and voicemail/fax/busy end cleanly with no Realtime session. A natural goodbye triggers a confirmed `end_call`; an ordinary handset hangup is also fully supported. Both paths clear the transcript into the same consent-gated summary lifecycle, after which the transcript is discarded.

---

## Privacy boundaries

Privacy is enforced in the architecture, not layered on after:

- **Raw audio is never persisted. Transcripts live only in memory** through consent-gated extraction after a call, then are discarded and never written to SQLite.
- **Two separate, revocable consent layers.** `summary_retention` gates whether any private continuity memory is written at all. `care_summary_sharing` separately gates whether a dashboard-visible shared care recap is produced. That recap never includes a diagnosis, professional conclusion, or advice Iris did not actually give. Private memory fields and recall anchors never reach the dashboard.
- **The dashboard shows only allowlisted, human-readable events.** No SMS body, provider identifier, raw transcript, recall anchor, Shield scenario, or audit metadata ever reaches the browser.
- **SMS is opt-in and approval-gated.** Iris only ever texts a contact whose current phone matches an active, separately recorded opt-in, and every send is approval-gated through a durable outbox with a server-owned `Iris:` prefix and HELP/STOP footer.

---

## Running it yourself

### Local development

Prerequisites: Node.js 22+ and an OpenAI API key.

```bash
cd server && npm install && npm run db:seed && npm run dev
cd frontend && npm install && npm run dev
```

Copy [`server/.env.example`](server/.env.example) to `server/.env` and set `OPENAI_API_KEY` and a long `IRIS_ADMIN_TOKEN`. **Never put the API key in the frontend.** Open the frontend and enter the token to reach the operator dashboard. Operators can add people and trusted contacts, create expiring revocable dashboard links, and create one-time SMS opt-in links.

### Live phone calls (local)

A live call needs Twilio credentials and a public HTTPS/WSS URL Twilio can reach (a tunnel works for local dev). Set these in `server/.env`:

- `IRIS_PUBLIC_BASE_URL`: the public URL terminating at this server.
- `IRIS_DEMO_PHONE_E164`: the authorized destination phone Iris calls when using the seeded demo person; set it before `npm run db:seed`.
- `TWILIO_PHONE_NUMBER`: Iris's Twilio from-number (not the destination).
- `TWILIO_MESSAGING_SERVICE_SID`: required for any SMS; configure Twilio Advanced Opt-Out to match `IRIS_SMS_HELP_TEXT`.
- `IRIS_FAREWELL_CLOSE_TIMEOUT_MS`: optional; defaults to `8000`. Bounds only a missing completion event after a tool-driven goodbye; it is not an idle-call timeout.

Sign in as the operator, press **Call now**, answer the phone, and talk with Iris. The seed grants both private-memory and shared-care-recap consent for the demo person. Its seeded trusted contact is deliberately non-routable but opted in for automated tests. For a live Bridge or Shield text, add a trusted contact with a number you control and complete the public web opt-in first.

Twilio accepting an SMS is not proof of delivery. US long-code delivery may require A2P 10DLC registration, which is external to Iris. Every production body begins with one `Iris:` prefix and ends with `Reply HELP for help. Reply STOP to opt out.` If delivery remains uncertain, an operator may use **Retry SMS** after accepting that a retry can create a duplicate by design.

### Hosted deployment (Railway)

The seeded local workflow above is the reproducible fallback. The container serves the production dashboard and public SPA routes such as `/opt-in` from Express; `/api/*`, Twilio webhooks, and the Media Stream endpoint remain server routes.

1. Deploy from this repository and generate one public HTTPS domain.
2. Attach a persistent volume at `/app/data` (the image pins `IRIS_DATABASE_PATH=/app/data/iris.sqlite`); keep the service at one replica — SQLite and active phone sessions are intentionally single-process in this prototype.
3. Set `IRIS_PUBLIC_BASE_URL` and `FRONTEND_ORIGIN` to the same Railway domain, plus the OpenAI key and safety identifier, `IRIS_ADMIN_TOKEN`, the Twilio Voice and Messaging Service credentials, `IRIS_DEMO_PHONE_E164`, and the SMS/legal settings from [`server/.env.example`](server/.env.example). Startup fails if `FRONTEND_ORIGIN` is missing.
4. Point the Twilio Messaging Service inbound webhook at `https://your-domain/api/messages/inbound`. Iris supplies its own Voice TwiML and status-callback URLs per call. Run `npm run db:seed:prod` from the Railway shell only to reset the demo fixture.

> SMS enrollment depends on a live Messaging Service and registered A2P 10DLC campaign. Until that clears, confirmation delivery may fail or require operator recovery (that's external carrier configuration, not an enrollment-data failure).

The hosted opt-in form uses `IRIS_PRIVACY_URL` and `IRIS_TERMS_URL`, which default to Iris's public legal pages. Keep those URLs public and HTTPS.

---

## Repository layout

```text
iris/
├── docs/
│   └── architecture.md      # detailed design and safety constraints
├── frontend/                # dashboard and public SMS opt-in page
│   └── src/
├── server/                  # API, telephony, and persona ownership
│   └── src/
│       └── personas/        # versioned Iris persona (iris-v1.ts)
└── README.md
```

For the full design rationale, safety constraints, and call-completion details, see [`docs/architecture.md`](docs/architecture.md).

---

## Deliberate deferrals

Some things are intentionally out of scope for this demo: Translator (reading a confusing letter into plain-language steps) is not yet a vertical slice, there's no automatic retry for uncertain SMS sends, and call recording, raw-transcript storage, and analytics persistence are all deliberately excluded by design.
