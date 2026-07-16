import { randomUUID } from "node:crypto";
import twilio from "twilio";

import type { TelephonyConfig } from "./config.js";
import type { IrisRepositories } from "./db/repositories.js";

type MessagingClient = { messages: { create(input: { to: string; from: string; body: string; statusCallback: string }): Promise<{ sid: string; status: string }> } };
type TwilioRequestError = Error & { status?: unknown; code?: unknown };

// How long an outbox claim may sit in `dispatching` before a sweep treats it as
// an abandoned (uncertain) send and makes it retryable again. It is deliberately
// generous: a message Twilio actually accepted would have delivered its status
// callback and reconciled to `dispatched` (and thus be skipped) long before this.
export const DEFAULT_STALE_DISPATCH_MS = 15 * 60 * 1000;

export class ActionDispatcher {
  constructor(
    private readonly repositories: IrisRepositories,
    private readonly config: TelephonyConfig,
    private readonly client: MessagingClient = twilio(config.twilioAccountSid, config.twilioAuthToken),
    private readonly staleDispatchMs: number = DEFAULT_STALE_DISPATCH_MS,
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

  /**
   * Recovers dispatches abandoned in `dispatching` by an uncertain (network or
   * timeout) failure that never received a Twilio callback. After the stale
   * window they are made retryable and re-dispatched, so a send that never
   * reached Twilio cannot stay stuck indefinitely. Intended to be swept
   * periodically; accepts an injectable clock for deterministic testing.
   */
  async recoverStaleDispatches(nowMs: number = Date.now()) {
    const cutoff = new Date(nowMs - this.staleDispatchMs).toISOString();
    const stale = this.repositories.reclaimStaleDispatches(cutoff);
    const outcomes: Array<{ actionId: string; ok: boolean }> = [];
    for (const row of stale) {
      this.audit(row.personId, row.actionRequestId, "action.dispatch_recovered", { channel: "sms" });
      try {
        const dispatched = await this.dispatchSms(row.actionRequestId);
        outcomes.push({ actionId: row.actionRequestId, ok: dispatched !== null });
      } catch {
        // A repeat uncertain failure leaves the claim dispatching for the next
        // sweep; a terminal 4xx marks it failed. Either way it is not stuck.
        outcomes.push({ actionId: row.actionRequestId, ok: false });
      }
    }
    return outcomes;
  }

  validateWebhook(signature: string | undefined, path: string, body: Record<string, unknown>) {
    return !!signature && twilio.validateRequest(this.config.twilioAuthToken, signature, `${this.config.publicBaseUrl}${path}`, body);
  }

  private audit(personId: string, actionId: string, action: string, metadata: unknown) {
    this.repositories.createEvent({ id: randomUUID(), personId, type: action, payload: metadata });
    this.repositories.createAuditEvent({ id: randomUUID(), personId, action, targetId: actionId, metadata });
  }
}
