import { randomUUID } from "node:crypto";

import type { ActionDispatcher } from "./actions.js";
import type { IrisRepositories } from "./db/repositories.js";
import { formatIrisSms, truncateSmsContent } from "./sms.js";

export class BridgeService {
  constructor(private readonly repositories: IrisRepositories, private readonly actions: ActionDispatcher) {}

  context(personId: string) {
    const contacts = this.repositories.listSmsEligibleTrustedContacts(personId).map((contact) => ({ id: contact.id, name: contact.displayName, relationship: contact.relationship }));
    if (!this.repositories.hasActiveConsent(personId, "summary_retention")) {
      return { memories: [], recallAnchor: null, contacts };
    }
    const memories = this.repositories.listMemories(personId)
      .map((memory) => ({ category: memory.category, value: JSON.parse(memory.payload_json) }));
    return {
      memories,
      recallAnchor: this.repositories.findLatestRecallAnchor(personId),
      contacts,
    };
  }

  async sendApprovedSms(input: { callId: string; personId: string; trustedContactId: string; message: string; approvalId: string }) {
    const contact = this.repositories.getSmsEligibleTrustedContact({ id: input.trustedContactId, personId: input.personId });
    const body = formatIrisSms(truncateSmsContent(input.message));
    if (!contact || !body) return { ok: false };
    const idempotencyKey = `bridge:${input.approvalId}`;
    const existing = this.repositories.findActionRequestByIdempotencyKey(idempotencyKey);
    // Only a dispatched record is terminally complete. A cancelled or failed
    // record is a terminal failure. pending_approval/approved records were left
    // mid-flight by an interruption, so resume their dispatch instead of aborting.
    if (existing?.status === "dispatched") return { ok: true, contactName: contact.displayName };
    if (existing && existing.status !== "pending_approval" && existing.status !== "approved") {
      return { ok: false, contactName: contact.displayName };
    }
    const actionId = existing?.id ?? randomUUID();
    if (!existing) {
      this.repositories.createActionRequest({
        id: actionId, personId: input.personId, sourceCallId: input.callId, feature: "bridge", actionType: "sms",
        approvalSource: "spoken_call", idempotencyKey, payload: { to: contact.phoneE164, body },
      });
    }
    this.actions.approve(actionId, "spoken_call");
    const dispatched = await this.actions.dispatchSms(actionId);
    if (!dispatched) return { ok: false, contactName: contact.displayName };
    this.repositories.createEvent({ id: randomUUID(), personId: input.personId, callId: input.callId, type: "bridge.sms_sent", payload: { contactName: contact.displayName } });
    return { ok: true, contactName: contact.displayName };
  }
}
