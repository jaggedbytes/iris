import assert from "node:assert/strict";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

test("SMS dispatch requires approval and is idempotent", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "answered" });
  repositories.createActionRequest({ id: "action-a", personId: "person-a", sourceCallId: "call-a", feature: "bridge", actionType: "sms", idempotencyKey: "same-action", payload: { to: "+15550002222", body: "Please call me." } });
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
    dispatcher.recordDelivery("action-a", "SM123", "delivered");
    assert.deepEqual(repositories.listEvents("person-a").map((event) => event.type).sort(), ["action.approved", "action.dispatched", "sms.delivery_updated"].sort());
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "sms.delivery_updated").length, 1);
    const deliveryEvent = repositories.listEvents("person-a").find((event) => event.type === "sms.delivery_updated");
    assert.deepEqual(deliveryEvent?.payload, { channel: "sms", status: "delivered" });
    assert.deepEqual(
      repositories.listEvents("person-a").map((event) => event.callId),
      ["call-a", "call-a", "call-a"],
    );
  } finally { closeDatabase(database); }
});

test("non-call enrollment SMS lifecycle events remain unlinked", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({
    id: "enrollment-action", personId: "person-a", feature: "enrollment", actionType: "sms_confirmation",
    idempotencyKey: "enrollment-confirmation", payload: { to: "+15550002222", body: "Confirmation" },
  });
  const dispatcher = new ActionDispatcher(repositories, {
    twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe",
  }, { messages: { create: async () => ({ sid: "SMenrollment", status: "queued" }) } });
  try {
    assert.ok(dispatcher.approve("enrollment-action", "web_form"));
    await dispatcher.dispatchSms("enrollment-action");
    dispatcher.recordDelivery("enrollment-action", "SMenrollment", "delivered");
    assert.deepEqual(repositories.listEvents("person-a").map((event) => event.callId), [null, null, null]);
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

test("updateActionRequest compare-and-set only transitions from the expected status", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-cas", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "cas", payload: { to: "+15550002222", body: "Hello" } });
  try {
    assert.equal(repositories.updateActionRequest({ id: "action-cas", status: "approved", expectedStatus: "pending_approval" })?.status, "approved");
    assert.equal(repositories.updateActionRequest({ id: "action-cas", status: "dispatched", expectedStatus: "approved" })?.status, "dispatched");
    // A stale transition from an already-consumed status is a no-op and reports null.
    assert.equal(repositories.updateActionRequest({ id: "action-cas", status: "failed", expectedStatus: "approved" }), null);
    assert.equal(repositories.getActionRequest("action-cas")?.status, "dispatched");
  } finally { closeDatabase(database); }
});

test("finalizeActionDispatch aborts when the action-request CAS fails", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-cas-abort", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "cas-abort", payload: { to: "+15550002222", body: "Hello" } });
  try {
    // Claim the outbox while the action is still pending_approval (not approved),
    // so the CAS inside finalize must fail and leave no message/outbox write.
    assert.equal(repositories.claimActionDispatch("action-cas-abort"), true);
    assert.equal(
      repositories.finalizeActionDispatch({
        id: "msg-cas-abort",
        personId: "person-a",
        actionRequestId: "action-cas-abort",
        providerMessageId: "SMcasabort",
        deliveryStatus: "queued",
      }),
      false,
    );
    assert.equal(repositories.getActionRequest("action-cas-abort")?.status, "pending_approval");
    assert.equal(repositories.getActionDispatch("action-cas-abort")?.state, "dispatching");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM messages WHERE provider_message_id = ?").get("SMcasabort") as { count: number }).count,
      0,
    );
  } finally { closeDatabase(database); }
});

test("a stale uncertain dispatch is parked for review without an automatic second send", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-stale", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "stale", payload: { to: "+15550002222", body: "Hello" } });
  let attempts = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => {
    attempts += 1;
    throw new Error("network down"); // uncertain: no HTTP status — Twilio may still have accepted
  } } }, 15 * 60 * 1000);
  try {
    dispatcher.approve("action-stale", "test");
    await assert.rejects(dispatcher.dispatchSms("action-stale"), /Unable to dispatch message/);
    assert.equal(repositories.getActionDispatch("action-stale")?.state, "dispatching");
    assert.deepEqual(dispatcher.recoverStaleDispatches(Date.now()), []);
    assert.equal(attempts, 1);

    // After the window, park for review — never re-send automatically.
    assert.deepEqual(dispatcher.recoverStaleDispatches(Date.now() + 60 * 60 * 1000), ["action-stale"]);
    assert.equal(attempts, 1);
    assert.equal(repositories.getActionRequest("action-stale")?.status, "approved");
    assert.equal(repositories.getActionDispatch("action-stale")?.state, "needs_review");
    assert.equal(await dispatcher.dispatchSms("action-stale"), null);
    assert.equal(attempts, 1);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "action.dispatch_needs_review"), true);

    // A late Twilio callback for the first accepted send reconciles without a second send.
    dispatcher.recordDelivery("action-stale", "SMlate", "delivered");
    assert.equal(repositories.getActionRequest("action-stale")?.status, "dispatched");
    assert.equal(repositories.getActionDispatch("action-stale")?.provider_message_id, "SMlate");
    assert.equal(attempts, 1);
  } finally { closeDatabase(database); }
});

test("an operator can explicitly release a needs_review claim for a single retry", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createActionRequest({ id: "action-release", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "release", payload: { to: "+15550002222", body: "Hello" } });
  let attempts = 0;
  const dispatcher = new ActionDispatcher(repositories, { twilioAccountSid: "ACtest", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test", openaiApiKey: "key", safetyIdentifier: "safe" }, { messages: { create: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
    return { sid: "SMretry", status: "queued" };
  } } }, 1);
  try {
    dispatcher.approve("action-release", "test");
    await assert.rejects(dispatcher.dispatchSms("action-release"), /Unable to dispatch message/);
    assert.deepEqual(dispatcher.recoverStaleDispatches(Date.now() + 1_000), ["action-release"]);
    assert.equal(attempts, 1);

    assert.ok(dispatcher.releaseForRetry("action-release"));
    assert.equal(repositories.getActionDispatch("action-release")?.state, "retryable");
    assert.deepEqual(await dispatcher.dispatchSms("action-release"), { messageId: "SMretry", status: "queued" });
    assert.equal(attempts, 2);
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
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "sms.delivery_updated").length, 1);
    assert.deepEqual(repositories.listEvents("person-a").find((event) => event.type === "sms.delivery_updated")?.payload, { channel: "sms", status: "sent" });
  } finally { closeDatabase(database); }
});
