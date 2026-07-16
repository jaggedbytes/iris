import { randomUUID } from "node:crypto";
import twilio from "twilio";

import type { TelephonyConfig } from "./config.js";
import type { IrisRepositories } from "./db/repositories.js";

type MessagingClient = { messages: { create(input: { to: string; from: string; body: string; statusCallback: string }): Promise<{ sid: string; status: string }> } };
type TwilioRequestError = Error & { status?: unknown; code?: unknown };

export class ActionDispatcher {
  constructor(
    private readonly repositories: IrisRepositories,
    private readonly config: TelephonyConfig,
    private readonly client: MessagingClient = twilio(config.twilioAccountSid, config.twilioAuthToken),
  ) {}

  approve(actionId: string, approvalSource: string) {
    const action = this.repositories.getActionRequest(actionId);
    if (!action || action.status !== "pending_approval") return null;
    const approved = this.repositories.updateActionRequest({ id: actionId, status: "approved", approvalSource, expectedStatus: "pending_approval" });
    if (approved) this.audit(approved.personId, actionId, "action.approved", { source: approvalSource });
    return approved;
  }

  async dispatchSms(actionId: string) {
    const action = this.repositories.getActionRequest(actionId);
    if (!action || action.status !== "approved") return null;
    const payload = action.payload as { to?: unknown; body?: unknown };
    if (typeof payload.to !== "string" || typeof payload.body !== "string" || !payload.to || !payload.body) {
      this.repositories.updateActionRequest({ id: actionId, status: "failed", expectedStatus: "approved" });
      this.audit(action.personId, actionId, "action.failed", { channel: "sms", reason: "invalid_payload" });
      return null;
    }
    // Durable outbox claim: the action remains approved until the Twilio result
    // and message row are committed. An ambiguous interrupted send is never
    // retried automatically, preventing duplicate SMS.
    if (!this.repositories.claimActionDispatch(actionId)) return null;
    try {
      const message = await this.client.messages.create({
        to: payload.to, from: this.config.twilioPhoneNumber, body: payload.body,
        statusCallback: `${this.config.publicBaseUrl}/api/actions/${actionId}/messages/status`,
      });
      const finalized = this.repositories.finalizeActionDispatch({ id: randomUUID(), personId: action.personId, actionRequestId: action.id, providerMessageId: message.sid, deliveryStatus: message.status });
      if (finalized) this.audit(action.personId, actionId, "action.dispatched", { channel: "sms", providerMessageId: message.sid, status: message.status });
      return { messageId: message.sid, status: message.status };
    } catch (error) {
      const providerError = error as TwilioRequestError;
      if (providerError.status === 429) {
        this.repositories.retryActionDispatch(actionId);
        this.audit(action.personId, actionId, "action.dispatch_retryable", { channel: "sms", status: providerError.status, code: typeof providerError.code === "number" ? providerError.code : undefined });
        throw new Error("Unable to dispatch message.");
      }
      if (typeof providerError.status === "number" && providerError.status >= 400 && providerError.status < 500) {
        this.repositories.failActionDispatch(actionId);
        this.repositories.updateActionRequest({ id: actionId, status: "failed", expectedStatus: "approved" });
        this.audit(action.personId, actionId, "action.failed", { channel: "sms", reason: "provider_rejected", status: providerError.status, code: typeof providerError.code === "number" ? providerError.code : undefined });
        throw new Error("Unable to dispatch message.");
      }
      this.audit(action.personId, actionId, "action.dispatch_uncertain", { channel: "sms" });
      throw new Error("Unable to dispatch message.");
    }
  }

  recordDelivery(actionId: string, providerMessageId: string, status: string) {
    const action = this.repositories.getActionRequest(actionId);
    const dispatch = this.repositories.getActionDispatch(actionId);
    if (action && dispatch?.state === "dispatching") {
      const finalized = this.repositories.finalizeActionDispatch({ id: randomUUID(), personId: action.personId, actionRequestId: action.id, providerMessageId, deliveryStatus: status });
      if (finalized) this.audit(action.personId, actionId, "action.reconciled", { channel: "sms", providerMessageId, status });
    }
    this.repositories.updateMessageDelivery(providerMessageId, status);
  }

  validateWebhook(signature: string | undefined, path: string, body: Record<string, unknown>) {
    return !!signature && twilio.validateRequest(this.config.twilioAuthToken, signature, `${this.config.publicBaseUrl}${path}`, body);
  }

  private audit(personId: string, actionId: string, action: string, metadata: unknown) {
    this.repositories.createEvent({ id: randomUUID(), personId, type: action, payload: metadata });
    this.repositories.createAuditEvent({ id: randomUUID(), personId, action, targetId: actionId, metadata });
  }
}
