import { randomUUID } from "node:crypto";

import type { ActionDispatcher } from "./actions.js";
import type { IrisRepositories } from "./db/repositories.js";
import { formatIrisSms, truncateSmsContent } from "./sms.js";

type BridgeMemory = { category: string; value: unknown };

/** Prefer an explicit recall anchor; otherwise seed from a named person or open topic. */
export function resolveRecallOpener(input: {
  recallAnchor: string | null;
  memories: BridgeMemory[];
}): string | null {
  const anchor = input.recallAnchor?.trim() ?? "";
  if (anchor.length > 0 && anchor.length <= 160) return anchor;

  // listMemories is newest-first; take the first usable person or open topic.
  for (const memory of input.memories) {
    if (memory.category === "named_person") {
      const value = memory.value as { name?: unknown; relationshipOrContext?: unknown };
      if (typeof value.name !== "string") continue;
      const name = value.name.trim();
      if (!name || name.length > 80) continue;
      const context = typeof value.relationshipOrContext === "string"
        ? value.relationshipOrContext.trim()
        : "";
      if (context && context.length <= 120) {
        const combined = `${name} (${context})`;
        if (combined.length <= 160) return combined;
      }
      return name.slice(0, 160);
    }
    if (memory.category === "unresolved_topic") {
      const value = memory.value as { topic?: unknown };
      if (typeof value.topic !== "string") continue;
      const topic = value.topic.trim();
      if (topic.length > 0 && topic.length <= 160) return topic;
    }
  }
  return null;
}

export class BridgeService {
  constructor(private readonly repositories: IrisRepositories, private readonly actions: ActionDispatcher) {}

  context(personId: string) {
    const contacts = this.repositories.listSmsEligibleTrustedContacts(personId).map((contact) => ({ id: contact.id, name: contact.displayName, relationship: contact.relationship }));
    if (!this.repositories.hasActiveConsent(personId, "summary_retention")) {
      return { memories: [], recallOpener: null, contacts };
    }
    const memories = this.repositories.listMemories(personId)
      .map((memory) => ({ category: memory.category, value: JSON.parse(memory.payload_json) }));
    return {
      memories,
      recallOpener: resolveRecallOpener({
        recallAnchor: this.repositories.findLatestRecallAnchor(personId),
        memories,
      }),
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
