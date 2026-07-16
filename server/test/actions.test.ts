import assert from "node:assert/strict";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

test("SMS dispatch requires approval and is idempotent", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-a", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "same-action", payload: { to: "+15550002222", body: "Please call me." } });
  let sends = 0;
  const dispatcher = new ActionDispatcher(repositories, {
    twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe",
  }, { messages: { create: async () => { sends += 1; return { sid: "SM123", status: "queued" }; } } });
  try {
    assert.equal(await dispatcher.dispatchSms("action-a"), null);
    assert.equal(dispatcher.approve("action-a", "test" )?.status, "approved");
    assert.deepEqual(await dispatcher.dispatchSms("action-a"), { messageId: "SM123", status: "queued" });
    assert.equal(await dispatcher.dispatchSms("action-a"), null);
    assert.equal(sends, 1);
    assert.equal(repositories.getActionRequest("action-a")?.status, "dispatched");
    dispatcher.recordDelivery("SM123", "delivered");
    assert.deepEqual(repositories.listEvents("person-a").map((event) => event.type).sort(), ["action.approved", "action.dispatched"].sort());
  } finally { closeDatabase(database); }
});

test("SMS provider failure marks the approved action failed without persisting its body", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-fail", personId: "person-a", feature: "shield", actionType: "sms", idempotencyKey: "provider-failure", payload: { to: "+15550002222", body: "Sensitive message content" } });
  const dispatcher = new ActionDispatcher(repositories, {
    twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe",
  }, { messages: { create: async () => { throw new Error("provider down"); } } });
  try {
    dispatcher.approve("action-fail", "test");
    await assert.rejects(dispatcher.dispatchSms("action-fail"), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest("action-fail")?.status, "failed");
    const serializedEvents = JSON.stringify(repositories.listEvents("person-a"));
    assert.equal(serializedEvents.includes("Sensitive message content"), false);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "action.failed"), true);
  } finally { closeDatabase(database); }
});

test("invalid approved SMS payload becomes a terminal failure", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-invalid", personId: "person-a", feature: "translator", actionType: "sms", idempotencyKey: "invalid-payload", payload: { to: null } });
  const dispatcher = new ActionDispatcher(repositories, {
    twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe",
  }, { messages: { create: async () => ({ sid: "never", status: "queued" }) } });
  try {
    dispatcher.approve("action-invalid", "test");
    assert.equal(await dispatcher.dispatchSms("action-invalid"), null);
    assert.equal(repositories.getActionRequest("action-invalid")?.status, "failed");
  } finally { closeDatabase(database); }
});
