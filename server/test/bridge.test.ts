import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/actions.js";
import { BridgeService, resolveRecallOpener } from "../src/bridge.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

function grantSmsOptIn(repositories: ReturnType<typeof createRepositories>, trustedContactId: string, phoneE164 = "+15550002222") {
  repositories.recordTrustedContactSmsConsent({
    id: `sms-consent-${trustedContactId}`, trustedContactId, phoneE164,
    status: "granted", source: "web_form", disclosureVersion: "test",
  });
}

test("resolveRecallOpener prefers an anchor, then a named person, then an open topic", () => {
  assert.equal(resolveRecallOpener({
    recallAnchor: "your garden plans",
    memories: [
      { category: "named_person", value: { name: "Grace", relationshipOrContext: "friend who wore a dress" } },
      { category: "unresolved_topic", value: { topic: "weekend plans" } },
    ],
  }), "your garden plans");
  assert.equal(resolveRecallOpener({
    recallAnchor: null,
    memories: [
      { category: "durable_fact", value: { fact: "Avery gardens." } },
      { category: "named_person", value: { name: "Grace", relationshipOrContext: "friend who wore a dress" } },
      { category: "unresolved_topic", value: { topic: "weekend plans" } },
    ],
  }), "Grace (friend who wore a dress)");
  assert.equal(resolveRecallOpener({
    recallAnchor: null,
    memories: [
      { category: "durable_fact", value: { fact: "Avery gardens." } },
      { category: "unresolved_topic", value: { topic: "weekend plans" } },
    ],
  }), "weekend plans");
  assert.equal(resolveRecallOpener({
    recallAnchor: "  ",
    memories: [{ category: "named_person", value: { name: "Grace" } }],
  }), "Grace");
  assert.equal(resolveRecallOpener({ recallAnchor: null, memories: [] }), null);
});

test("Bridge recalls scoped memory and sends only to the selected trusted contact", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  grantSmsOptIn(repositories, "contact-a");
  repositories.createMemory({ id: "memory-a", personId: "person-a", sourceCallId: "call-a", category: "durable_fact", payload: { fact: "Avery enjoys gardening." } });
  let sent = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => { sent += 1; return { sid: "SM123", status: "queued" }; } } });
  const bridge = new BridgeService(repositories, dispatcher);
  try {
    const context = bridge.context("person-a");
    assert.deepEqual(context.contacts.map((contact) => contact.id), ["contact-a"]);
    assert.deepEqual(context.memories, [{ category: "durable_fact", value: { fact: "Avery enjoys gardening." } }]);
    assert.equal(context.recallOpener, null);
    assert.equal((await bridge.sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "contact-a", message: "Could you call me about the garden?", approvalId: "tool-call-1" })).ok, true);
    assert.equal((await bridge.sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "contact-a", message: "Could you call me about the garden?", approvalId: "tool-call-1" })).ok, true);
    assert.equal(sent, 1);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "bridge.sms_sent"), true);
    assert.equal(repositories.listEvents("person-a").every((event) => event.callId === "call-a"), true);
    assert.equal((await bridge.sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "other", message: "no", approvalId: "tool-call-2" })).ok, false);
    assert.equal(sent, 1);
  } finally { closeDatabase(database); }
});

test("Bridge exposes only the latest valid recall anchor while consent is active", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  grantSmsOptIn(repositories, "contact-a");
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createMemory({ id: "memory-fact", personId: "person-a", sourceCallId: "call-a", category: "durable_fact", payload: { fact: "Avery enjoys gardening." } });
  repositories.createMemory({ id: "memory-anchor-old", personId: "person-a", sourceCallId: "call-a", category: "recall_anchor", payload: { anchor: "your roses" } });
  repositories.createMemory({ id: "memory-anchor-new", personId: "person-a", sourceCallId: "call-a", category: "recall_anchor", payload: { anchor: "your garden plans" } });
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" });
  const bridge = new BridgeService(repositories, dispatcher);
  try {
    const active = bridge.context("person-a");
    assert.equal(active.recallOpener, "your garden plans");
    assert.deepEqual(active.memories, [{ category: "durable_fact", value: { fact: "Avery enjoys gardening." } }]);

    repositories.recordConsent({ id: "consent-revoked", personId: "person-a", kind: "summary_retention", status: "revoked", source: "test" });
    const revoked = bridge.context("person-a");
    assert.equal(revoked.recallOpener, null);
    assert.deepEqual(revoked.memories, []);
    assert.deepEqual(revoked.contacts.map((contact) => contact.id), ["contact-a"]);
  } finally { closeDatabase(database); }
});

test("Bridge memory context keeps durable facts when many recall anchors exist", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  grantSmsOptIn(repositories, "contact-a");
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createMemory({ id: "memory-fact", personId: "person-a", sourceCallId: "call-a", category: "durable_fact", payload: { fact: "Avery enjoys gardening." } });
  for (let index = 0; index < 25; index += 1) {
    repositories.createMemory({
      id: `memory-anchor-${index}`,
      personId: "person-a",
      sourceCallId: "call-a",
      category: "recall_anchor",
      payload: { anchor: `anchor ${index}` },
    });
  }
  const bridge = new BridgeService(
    repositories,
    new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }),
  );
  try {
    const context = bridge.context("person-a");
    assert.deepEqual(context.memories, [{ category: "durable_fact", value: { fact: "Avery enjoys gardening." } }]);
    assert.equal(context.recallOpener, "anchor 24");
    assert.equal(repositories.listMemories("person-a").some((memory) => memory.category === "recall_anchor"), false);
  } finally { closeDatabase(database); }
});

test("Bridge resumes an interrupted approved action on retry instead of aborting", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "answered" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  grantSmsOptIn(repositories, "contact-a");
  let attempts = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => {
    attempts += 1;
    if (attempts === 1) { const error = new Error("rate limited") as Error & { status: number }; error.status = 429; throw error; }
    return { sid: "SMresume", status: "queued" };
  } } });
  const bridge = new BridgeService(repositories, dispatcher);
  try {
    await assert.rejects(bridge.sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "contact-a", message: "Please call me.", approvalId: "tool-call-resume" }), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest(repositories.listActionRequests("person-a")[0].id)?.status, "approved");
    const resumed = await bridge.sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "contact-a", message: "Please call me.", approvalId: "tool-call-resume" });
    assert.equal(resumed.ok, true);
    assert.equal(attempts, 2);
    assert.equal(repositories.listActionRequests("person-a").length, 1);
    assert.equal(repositories.getActionRequest(repositories.listActionRequests("person-a")[0].id)?.status, "dispatched");
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "bridge.sms_sent").length, 1);
  } finally { closeDatabase(database); }
});

test("Bridge propagates provider rejection and creates no bridge-sent event", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "answered" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  grantSmsOptIn(repositories, "contact-a");
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => { throw new Error("rejected"); } } });
  try {
    await assert.rejects(new BridgeService(repositories, dispatcher).sendApprovedSms({ callId: "call-a", personId: "person-a", trustedContactId: "contact-a", message: "Please call me.", approvalId: "tool-call-fail" }), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest(repositories.listActionRequests("person-a")[0].id)?.status, "approved");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "bridge.sms_sent"), false);
  } finally { closeDatabase(database); }
});
