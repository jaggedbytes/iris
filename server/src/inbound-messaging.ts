import { Router } from "express";

import type { ActionDispatcher } from "./actions.js";
import type { IrisRepositories } from "./db/repositories.js";

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

function isStopRequest(body: Record<string, unknown>) {
  const optOutType = typeof body.OptOutType === "string"
    ? body.OptOutType.trim().toUpperCase()
    : "";
  if (optOutType === "STOP") return true;
  const inboundText = typeof body.Body === "string"
    ? body.Body.trim().toUpperCase()
    : "";
  return STOP_KEYWORDS.has(inboundText);
}

export function createInboundMessagingRouter(input: {
  repositories: IrisRepositories;
  actions: Pick<ActionDispatcher, "validateWebhook">;
}) {
  const router = Router();

  router.post("/inbound", (request, response) => {
    if (!input.actions.validateWebhook(
      request.header("x-twilio-signature"),
      request.originalUrl,
      request.body,
    )) {
      response.status(403).end();
      return;
    }
    const from = typeof request.body?.From === "string" ? request.body.From.trim() : "";
    if (from && isStopRequest(request.body)) {
      // No inbound message text, phone number, or consent evidence is rendered
      // or logged. The database uses the sender number only to append local
      // revocations for every matching trusted-contact record.
      input.repositories.revokeTrustedContactSmsOptInsByPhone(from);
    }
    // HELP is handled by the configured Twilio Messaging Service; START never
    // restores local eligibility. A new web opt-in is always required.
    response.type("text/xml").send("<Response/>");
  });

  return router;
}
