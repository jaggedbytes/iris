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
    dispatcher.recordDelivery("action-a", "SM123", "delivered");
    assert.deepEqual(repositories.listEvents("person-a").map((event) => event.type).sort(), ["action.approved", "action.dispatched"].sort());
  } finally { closeDatabase(database); }
});

test("SMS provider failure leaves a durable dispatching claim without persisting its body", async () => {
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
    assert.equal(repositories.getActionRequest("action-fail")?.status, "approved");
    assert.equal(repositories.getActionDispatch("action-fail")?.state, "dispatching");
    const serializedEvents = JSON.stringify(repositories.listEvents("person-a"));
    assert.equal(serializedEvents.includes("Sensitive message content"), false);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "action.dispatch_uncertain"), true);
    dispatcher.recordDelivery("action-fail", "SMrecovered", "sent");
    assert.equal(repositories.getActionRequest("action-fail")?.status, "dispatched");
    assert.equal(repositories.getActionDispatch("action-fail")?.provider_message_id, "SMrecovered");
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

test("Twilio 4xx rejection creates a terminal failed outbox entry", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-4xx", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "4xx", payload: { to: "+15550002222", body: "Hello" } });
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => { const error = new Error("bad request") as Error & { status: number }; error.status = 400; throw error; } } });
  try {
    dispatcher.approve("action-4xx", "test");
    await assert.rejects(dispatcher.dispatchSms("action-4xx"), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest("action-4xx")?.status, "failed");
    assert.equal(repositories.getActionDispatch("action-4xx")?.state, "failed");
  } finally { closeDatabase(database); }
});

test("Twilio rate limiting leaves a retryable claim that can be safely retried", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-rate-limited", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "rate-limited", payload: { to: "+15550002222", body: "Hello" } });
  let attempts = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => {
    attempts += 1;
    if (attempts === 1) { const error = new Error("rate limited") as Error & { status: number }; error.status = 429; throw error; }
    return { sid: "SM429", status: "queued" };
  } } });
  try {
    dispatcher.approve("action-rate-limited", "test");
    await assert.rejects(dispatcher.dispatchSms("action-rate-limited"), /Unable to dispatch message/);
    assert.equal(repositories.getActionRequest("action-rate-limited")?.status, "approved");
    assert.equal(repositories.getActionDispatch("action-rate-limited")?.state, "retryable");
    assert.deepEqual(await dispatcher.dispatchSms("action-rate-limited"), { messageId: "SM429", status: "queued" });
    assert.equal(attempts, 2);
  } finally { closeDatabase(database); }
});

test("outbox terminal and retryable transitions only apply while dispatching", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-state-guard", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "state-guard", payload: {} });
  try {
    assert.equal(repositories.claimActionDispatch("action-state-guard"), true);
    repositories.failActionDispatch("action-state-guard");
    repositories.retryActionDispatch("action-state-guard");
    assert.equal(repositories.getActionDispatch("action-state-guard")?.state, "failed");
  } finally { closeDatabase(database); }
});

test("an early delivery callback makes dispatch finalization idempotent", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-race", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "race", payload: { to: "+15550002222", body: "Hello" } });
  let dispatcher: ActionDispatcher;
  dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => {
    dispatcher.recordDelivery("action-race", "SMrace", "sent");
    return { sid: "SMrace", status: "queued" };
  } } });
  try {
    dispatcher.approve("action-race", "test");
    assert.deepEqual(await dispatcher.dispatchSms("action-race"), { messageId: "SMrace", status: "queued" });
    assert.equal(repositories.getActionRequest("action-race")?.status, "dispatched");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM messages WHERE provider_message_id = ?").get("SMrace")?.count, 1);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "action.dispatch_uncertain"), false);
  } finally { closeDatabase(database); }
});
