import assert from "node:assert/strict";
import test from "node:test";
import { ActionDispatcher } from "../src/actions.js";
import { BridgeService } from "../src/bridge.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

test("Bridge recalls scoped memory and sends only to the selected trusted contact", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  repositories.createMemory({ id: "memory-a", personId: "person-a", sourceCallId: "call-a", category: "durable_fact", payload: { fact: "Avery enjoys gardening." } });
  let sent = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => { sent += 1; return { sid: "SM123", status: "queued" }; } } });
  const bridge = new BridgeService(repositories, dispatcher);
  try {
    const context = bridge.context("person-a");
    assert.deepEqual(context.contacts.map((contact) => contact.id), ["contact-a"]);
    assert.deepEqual(context.memories, [{ category: "durable_fact", value: { fact: "Avery enjoys gardening." } }]);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-a", message: "Could you call me about the garden?", approvalId: "tool-call-1" })).ok, true);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-a", message: "Could you call me about the garden?", approvalId: "tool-call-1" })).ok, true);
    assert.equal(sent, 1);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "bridge.sms_sent"), true);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "other", message: "no", approvalId: "tool-call-2" })).ok, false);
    assert.equal(sent, 1);
  } finally { closeDatabase(database); }
});

test("Bridge propagates provider rejection and creates no bridge-sent event", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => { throw new Error("rejected"); } } });
  try {
    await assert.rejects(new BridgeService(repositories, dispatcher).sendApprovedSms({ personId: "person-a", trustedContactId: "contact-a", message: "Please call me.", approvalId: "tool-call-fail" }), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest(repositories.listActionRequests("person-a")[0].id)?.status, "failed");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "bridge.sms_sent"), false);
  } finally { closeDatabase(database); }
});
