import { randomUUID } from "node:crypto";

import { Router } from "express";
import rateLimit from "express-rate-limit";

import type { ActionDispatcher } from "./actions.js";
import type { EnrollmentConfig } from "./config.js";
import type { IrisRepositories } from "./db/repositories.js";
import { isE164 } from "./phone.js";
import { formatIrisSms, truncateSmsContent } from "./sms.js";
import { hashToken } from "./tokens.js";

export function createSmsOptInConfirmation(personDisplayName: string) {
  return formatIrisSms(truncateSmsContent(
    `You’re subscribed to care check-in and Shield alert texts for ${personDisplayName}. Msg frequency varies. Msg & data rates may apply.`,
  ));
}

export class EnrollmentService {
  constructor(
    private readonly repositories: IrisRepositories,
    private readonly actions: Pick<ActionDispatcher, "dispatchSms">,
    private readonly config: EnrollmentConfig,
  ) {}

  validateInvitation(token: string) {
    const invitation = this.repositories.getActiveSmsOptInInvitationContext(hashToken(token));
    if (!invitation) return null;
    return {
      personDisplayName: invitation.personDisplayName,
      contactDisplayName: invitation.contactDisplayName,
      privacyUrl: this.config.privacyUrl,
      termsUrl: this.config.termsUrl,
      helpText: this.config.helpText,
    };
  }

  acceptInvitation(input: { token: string; phoneE164: string }) {
    const context = this.repositories.getActiveSmsOptInInvitationContext(hashToken(input.token));
    if (!context || context.contactPhoneE164 !== input.phoneE164) return null;
    const confirmationBody = createSmsOptInConfirmation(context.personDisplayName);
    if (!confirmationBody) return null;
    const enrollment = this.repositories.finalizeSmsOptInEnrollment({
      tokenHash: hashToken(input.token),
      phoneE164: input.phoneE164,
      consentId: randomUUID(),
      actionId: randomUUID(),
      confirmationBody,
      disclosureVersion: this.config.disclosureVersion,
    });
    if (!enrollment) return null;

    // The acceptance transaction is durable before Twilio is contacted. The
    // shared action dispatcher owns failure/uncertainty state in the outbox;
    // an SMS transport issue must not roll back the contact's recorded consent.
    void this.actions.dispatchSms(enrollment.actionId).catch(() => undefined);
    return { personDisplayName: enrollment.personDisplayName };
  }
}

export function createEnrollmentRouter(service: EnrollmentService) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Please wait before trying again." },
  });

  router.post("/validate", limiter, (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const invitation = token ? service.validateInvitation(token) : null;
    if (!invitation) {
      response.status(404).json({ error: "This opt-in link is unavailable." });
      return;
    }
    response.set("Cache-Control", "no-store").json(invitation);
  });

  router.post("/accept", limiter, (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const phoneE164 = request.body?.phoneE164;
    if (!isE164(phoneE164)) {
      response.status(400).json({ error: "Enter the invited mobile number in E.164 format." });
      return;
    }
    if (request.body?.accepted !== true) {
      response.status(400).json({ error: "Agree to receive texts before subscribing." });
      return;
    }
    if (!token) {
      response.status(404).json({ error: "This opt-in link is unavailable." });
      return;
    }
    const enrollment = service.acceptInvitation({ token, phoneE164 });
    if (!enrollment) {
      // Deliberately covers expired, consumed, and phone-mismatch cases so a
      // public caller cannot use the endpoint to probe invitation details.
      response.status(404).json({ error: "This opt-in link is unavailable." });
      return;
    }
    response.status(201).set("Cache-Control", "no-store").json({
      status: "subscribed",
      personDisplayName: enrollment.personDisplayName,
    });
  });

  return router;
}
