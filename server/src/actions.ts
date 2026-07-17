import { randomUUID } from "node:crypto";
import twilio from "twilio";

import type { TelephonyConfig } from "./config.js";
import type { IrisRepositories } from "./db/repositories.js";

type MessagingClient = { messages: { create(input: { to: string; from: string; body: string; statusCallback: string }): Promise<{ sid: string; status: string }> } };
type TwilioRequestError = Error & { status?: unknown; code?: unknown };

// How long an outbox claim may sit in `dispatching` before a sweep parks it for
// manual review. Uncertain failures do not prove Twilio rejected the send, so
// the sweep must never re-dispatch automatically.
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
      if (finalized) this.audit(
        action.personId,
        actionId,
        "action.dispatched",
        { channel: "sms", providerMessageId: message.sid, status: message.status },
        { channel: "sms", status: message.status },
      );
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
    let deliveryChanged = false;
    if (action && (dispatch?.state === "dispatching" || dispatch?.state === "needs_review")) {
      const finalized = this.repositories.finalizeActionDispatch({ id: randomUUID(), personId: action.personId, actionRequestId: action.id, providerMessageId, deliveryStatus: status });
      if (finalized) {
        deliveryChanged = true;
        this.audit(
          action.personId,
          actionId,
          "action.reconciled",
          { channel: "sms", providerMessageId, status },
          { channel: "sms", status },
        );
      }
    }
    if (action && this.repositories.updateMessageDelivery(providerMessageId, status)) {
      deliveryChanged = true;
    }
    if (action && deliveryChanged) {
      this.audit(
        action.personId,
        actionId,
        "sms.delivery_updated",
        { channel: "sms", providerMessageId, status },
        { channel: "sms", status },
      );
    }
  }

  /**
   * Parks stale `dispatching` claims for manual review. Does not re-send: a
   * network/timeout failure may still have been accepted by Twilio, so automatic
   * retry would risk a duplicate SMS. Late status callbacks can still reconcile
   * `needs_review` rows; an operator must explicitly release before a retry.
   */
  recoverStaleDispatches(nowMs: number = Date.now()) {
    const cutoff = new Date(nowMs - this.staleDispatchMs).toISOString();
    const stale = this.repositories.reclaimStaleDispatches(cutoff);
    for (const row of stale) {
      this.audit(row.personId, row.actionRequestId, "action.dispatch_needs_review", { channel: "sms" });
    }
    return stale.map((row) => row.actionRequestId);
  }

  /** Privileged: allow a needs_review claim to be claimed again by dispatchSms. */
  releaseForRetry(actionId: string) {
    const action = this.repositories.getActionRequest(actionId);
    if (!action || action.status !== "approved") return null;
    if (!this.repositories.releaseDispatchForRetry(actionId)) return null;
    this.audit(action.personId, actionId, "action.dispatch_released", { channel: "sms" });
    return action;
  }

  validateWebhook(signature: string | undefined, path: string, body: Record<string, unknown>) {
    return !!signature && twilio.validateRequest(this.config.twilioAuthToken, signature, `${this.config.publicBaseUrl}${path}`, body);
  }

  private audit(personId: string, actionId: string, action: string, auditMetadata: unknown, timelineMetadata: unknown = auditMetadata) {
    this.repositories.createEvent({ id: randomUUID(), personId, type: action, payload: timelineMetadata });
    this.repositories.createAuditEvent({ id: randomUUID(), personId, action, targetId: actionId, metadata: auditMetadata });
  }
}
