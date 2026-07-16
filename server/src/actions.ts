import { randomUUID } from "node:crypto";
import twilio from "twilio";

import type { TelephonyConfig } from "./config.js";
import type { IrisRepositories } from "./db/repositories.js";

type MessagingClient = { messages: { create(input: { to: string; from: string; body: string; statusCallback: string }): Promise<{ sid: string; status: string }> } };

export class ActionDispatcher {
  constructor(
    private readonly repositories: IrisRepositories,
    private readonly config: TelephonyConfig,
    private readonly client: MessagingClient = twilio(config.twilioAccountSid, config.twilioAuthToken),
  ) {}

  approve(actionId: string, approvalSource: string) {
    const action = this.repositories.getActionRequest(actionId);
    if (!action || action.status !== "pending_approval") return null;
    const approved = this.repositories.updateActionRequest({ id: actionId, status: "approved", approvalSource });
    if (approved) this.audit(approved.personId, actionId, "action.approved", { source: approvalSource });
    return approved;
  }

  async dispatchSms(actionId: string) {
    const action = this.repositories.getActionRequest(actionId);
    if (!action || action.status !== "approved") return null;
    const payload = action.payload as { to?: unknown; body?: unknown };
    if (typeof payload.to !== "string" || typeof payload.body !== "string" || !payload.to || !payload.body) {
      this.repositories.updateActionRequest({ id: actionId, status: "failed" });
      this.audit(action.personId, actionId, "action.failed", { channel: "sms", reason: "invalid_payload" });
      return null;
    }
    // Claim the approved request before its external side effect. Repeated calls
    // see `dispatched` and cannot send the same message again.
    this.repositories.updateActionRequest({ id: actionId, status: "dispatched" });
    try {
      const message = await this.client.messages.create({
        to: payload.to, from: this.config.twilioPhoneNumber, body: payload.body,
        statusCallback: `${this.config.publicBaseUrl}/api/actions/messages/status`,
      });
      this.repositories.createMessage({ id: randomUUID(), personId: action.personId, actionRequestId: action.id, providerMessageId: message.sid, deliveryStatus: message.status });
      this.audit(action.personId, actionId, "action.dispatched", { channel: "sms", providerMessageId: message.sid, status: message.status });
      return { messageId: message.sid, status: message.status };
    } catch {
      this.repositories.updateActionRequest({ id: actionId, status: "failed" });
      this.audit(action.personId, actionId, "action.failed", { channel: "sms" });
      throw new Error("Unable to dispatch message.");
    }
  }

  recordDelivery(providerMessageId: string, status: string) {
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
