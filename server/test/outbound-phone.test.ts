import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { BridgeService } from "../src/bridge.js";
import { createDatabase, createRepositories, closeDatabase } from "../src/db/index.js";
import { ShieldService } from "../src/shield.js";
import { ActiveCallConflictError, OutboundCallManager, type CallScheduler } from "../src/telephony/outbound.js";
import { friendlyRequesterToken, type SocketLike } from "../src/telephony/call-session.js";

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  throwOnSend = false;
  send(data: string) {
    if (this.throwOnSend) throw new Error("socket send failed");
    this.sent.push(data);
  }
  close() { this.closed = true; this.emit("close"); }
}

class FakeScheduler implements CallScheduler {
  scheduled: { callback: () => void; delayMs: number } | null = null;
  cleared = 0;
  setTimeout(callback: () => void, delayMs: number) {
    this.scheduled = { callback, delayMs };
    return { unref() {} };
  }
  clearTimeout() { this.cleared += 1; }
}

const telephonyConfig = {
  twilioAccountSid: "ACtest",
  twilioAuthToken: "test-auth-token",
  twilioPhoneNumber: "+15550001111",
  publicBaseUrl: "https://iris.test",
  openaiApiKey: "test-openai-key",
  safetyIdentifier: "iris-test",
  farewellCloseTimeoutMs: 8_000,
};

test("outbound calls use a token-bound μ-law stream and discard live transcript state", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const requestedCalls: Record<string, unknown>[] = [];
  const summaryInputs: Array<{ transcript: Array<{ speaker: string; text: string }> }> = [];
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async (input) => { requestedCalls.push(input); return { sid: "CA123" }; } } },
    () => realtime,
    { process: async (input) => { summaryInputs.push(input); } },
  );

  try {
    const { callId } = await manager.startCall("person-a");
    assert.equal(requestedCalls.length, 1);
    assert.equal(requestedCalls[0].to, "+15550002222");
    assert.equal(repositories.listCalls("person-a")[0].providerCallId, "CA123");

    manager.handleStatus(callId, "in-progress");
    assert.equal(repositories.listCalls("person-a")[0].status, "answered");

    const twiml = manager.twiml(callId);
    assert.match(twiml ?? "", /wss:\/\/iris\.test\/api\/telephony\/media/);
    assert.match(twiml ?? "", /<Parameter name="callId"/);

    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    const streamToken = /<Parameter name="streamToken" value="([^"]+)"/.exec(twiml ?? "")?.[1];
    assert.ok(streamToken);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" })));
    assert.equal(socket.closed, false);
    socket.emit("message", Buffer.from(JSON.stringify({
      event: "start",
      start: { streamSid: "MZ123", customParameters: { callId, streamToken } },
    })));
    socket.emit("message", Buffer.from(JSON.stringify({ event: "media", media: { payload: "ulaw-before-realtime-opens" } })));
    assert.deepEqual(realtime.sent, []);
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string; audio: { input: { format: { type: string } } } } };
    assert.equal(sessionUpdate.session.audio.input.format.type, "audio/pcmu");
    assert.equal(sessionUpdate.session.instructions.includes("Family-requested check-in metadata"), false);
    assert.equal(realtime.sent.length, 1);
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    assert.deepEqual(JSON.parse(realtime.sent[1]), { type: "input_audio_buffer.append", audio: "ulaw-before-realtime-opens" });

    socket.emit("message", Buffer.from(JSON.stringify({ event: "media", media: { payload: "ulaw-from-phone" } })));
    assert.deepEqual(JSON.parse(realtime.sent[2]), { type: "input_audio_buffer.append", audio: "ulaw-from-phone" });
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: "ulaw-from-iris" })));
    assert.deepEqual(JSON.parse(socket.sent[0]), { event: "media", streamSid: "MZ123", media: { payload: "ulaw-from-iris" } });
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
    assert.deepEqual(JSON.parse(socket.sent[1]), { event: "clear", streamSid: "MZ123" });
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "I am thinking about Ruth." })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "You should call Ruth today." })));

    // Twilio can report terminal status before the Media Stream gives us its
    // final close/transcription boundary. The established session owns it.
    manager.handleStatus(callId, "completed");
    assert.equal(repositories.listCalls("person-a")[0].status, "answered");
    socket.emit("close");
    const call = repositories.listCalls("person-a")[0];
    assert.equal(call.status, "completed");
    assert.equal(call.summaryJson, null);
    assert.equal(call.summaryState, "processing");
    assert.deepEqual(summaryInputs, [{ callId, personId: "person-a", transcript: [
      { speaker: "user", text: "I am thinking about Ruth." },
      { speaker: "assistant", text: "You should call Ruth today." },
    ] }]);
    const eventTypes = repositories.listEvents("person-a").map((event) => event.type);
    assert.deepEqual(eventTypes.sort(), ["call.attempted", "call.answered", "call.completed", "call.stream_started"].sort());
  } finally {
    closeDatabase(database);
  }
});

test("reuses an active call instead of creating a duplicate provider call", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  let providerCalls = 0;
  let resolveProviderCall: ((value: { sid: string }) => void) | undefined;
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => {
      providerCalls += 1;
      return new Promise<{ sid: string }>((resolve) => { resolveProviderCall = resolve; });
    } } },
    () => new FakeSocket(),
  );
  try {
    const firstPending = manager.startCall("person-a");
    const repeated = await manager.startCall("person-a");
    assert.equal(providerCalls, 1);
    assert.equal(repositories.listCalls("person-a").length, 1);
    resolveProviderCall?.({ sid: "CA1" });
    const first = await firstPending;
    assert.equal(repeated.callId, first.callId);

    manager.handleStatus(first.callId, "completed");
    const nextPending = manager.startCall("person-a");
    resolveProviderCall?.({ sid: "CA2" });
    const next = await nextPending;
    assert.notEqual(next.callId, first.callId);
    assert.equal(providerCalls, 2);
  } finally { closeDatabase(database); }
});

test("rejects a second trusted contact instead of reusing another contact's active call", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-b", personId: "person-a", displayName: "Sam", relationship: "son", phoneE164: "+15550003333" });
  let providerCalls = 0;
  let resolveProviderCall: ((value: { sid: string }) => void) | undefined;
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => {
      providerCalls += 1;
      return new Promise<{ sid: string }>((resolve) => { resolveProviderCall = resolve; });
    } } },
    () => new FakeSocket(),
  );
  try {
    const firstPending = manager.startCall("person-a", { trustedContactId: "contact-a", displayName: "Robin" });

    await assert.rejects(
      manager.startCall("person-a", { trustedContactId: "contact-b", displayName: "Sam" }),
      (error: unknown) => error instanceof ActiveCallConflictError,
    );
    assert.equal(providerCalls, 1);
    assert.equal(repositories.listCalls("person-a").length, 1);

    // The same contact still reuses the in-flight call idempotently.
    const sameContact = await manager.startCall("person-a", { trustedContactId: "contact-a", displayName: "Robin" });
    resolveProviderCall?.({ sid: "CA1" });
    const first = await firstPending;
    assert.equal(sameContact.callId, first.callId);
    assert.equal(providerCalls, 1);
  } finally { closeDatabase(database); }
});

test("family-requested calls retain the display name and use a friendly spoken token", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Mary Jane", relationship: "daughter", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createCall({ id: "call-memory", personId: "person-a", status: "completed" });
  repositories.createMemory({ id: "memory-anchor", personId: "person-a", sourceCallId: "call-memory", category: "recall_anchor", payload: { anchor: "your garden plans" } });
  const realtime = new FakeSocket();
  const bridge = new BridgeService(repositories, new ActionDispatcher(repositories, telephonyConfig));
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => ({ sid: "CA123" }) } },
    () => realtime,
    undefined,
    undefined,
    undefined,
    bridge,
  );
  try {
    assert.equal(friendlyRequesterToken("  Mary Jane  "), "Mary");
    const { callId } = await manager.startCall("person-a", { trustedContactId: "contact-a", displayName: "Mary Jane" });
    assert.equal((await manager.startCall("person-a", { trustedContactId: "contact-a", displayName: "Changed Name" })).callId, callId);
    const checkInEvents = repositories.listEvents("person-a").filter((event) => event.type === "check_in.requested");
    assert.deepEqual(checkInEvents.map((event) => event.payload), [{ requesterDisplayName: "Mary Jane" }]);

    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string } };
    assert.match(sessionUpdate.session.instructions, /Mary Jane/);
    assert.match(sessionUpdate.session.instructions, /"Mary" asked you to check in/);
    assert.match(sessionUpdate.session.instructions, /your garden plans/);
    assert.ok(
      sessionUpdate.session.instructions.indexOf('"Mary" asked you to check in') <
      sessionUpdate.session.instructions.indexOf("exactly one gentle invitation"),
    );
    assert.equal(sessionUpdate.session.instructions.includes('"recall_anchor"'), false);
  } finally { closeDatabase(database); }
});

test("a normal Bridge call gets one authoritative recall opener only when an anchor exists", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createCall({ id: "call-memory", personId: "person-a", status: "completed" });
  repositories.createMemory({ id: "memory-anchor", personId: "person-a", sourceCallId: "call-memory", category: "recall_anchor", payload: { anchor: "your garden plans" } });
  const realtime = new FakeSocket();
  const bridge = new BridgeService(repositories, new ActionDispatcher(repositories, telephonyConfig));
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, bridge,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string } };
    assert.match(sessionUpdate.session.instructions, /your garden plans/);
    assert.match(sessionUpdate.session.instructions, /exactly one gentle invitation/);
    assert.equal(sessionUpdate.session.instructions.includes("Family-requested check-in metadata"), false);
  } finally { closeDatabase(database); }
});

test("an active-consent Bridge call without an anchor does not volunteer prior details", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const bridge = new BridgeService(repositories, new ActionDispatcher(repositories, telephonyConfig));
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, bridge,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string } };
    assert.match(sessionUpdate.session.instructions, /Do not volunteer prior conversation details at the opening/);
    assert.equal(sessionUpdate.session.instructions.includes("offer exactly one gentle invitation"), false);
  } finally { closeDatabase(database); }
});

test("a revoked-consent Bridge call does not volunteer a previously stored anchor", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  repositories.createCall({ id: "call-memory", personId: "person-a", status: "completed" });
  repositories.createMemory({ id: "memory-anchor", personId: "person-a", sourceCallId: "call-memory", category: "recall_anchor", payload: { anchor: "your garden plans" } });
  repositories.recordConsent({ id: "consent-revoked", personId: "person-a", kind: "summary_retention", status: "revoked", source: "test" });
  const realtime = new FakeSocket();
  const bridge = new BridgeService(repositories, new ActionDispatcher(repositories, telephonyConfig));
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, bridge,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string } };
    assert.match(sessionUpdate.session.instructions, /Do not volunteer prior conversation details at the opening/);
    assert.equal(sessionUpdate.session.instructions.includes("offer exactly one gentle invitation"), false);
    assert.equal(sessionUpdate.session.instructions.includes("your garden plans"), false);
  } finally { closeDatabase(database); }
});

test("Bridge SMS runs once from a completed response.done function call", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550003333" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  let sends = 0;
  const dispatcher = new ActionDispatcher(repositories, telephonyConfig, { messages: { create: async () => { sends += 1; return { sid: "SM123", status: "queued" }; } } });
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, new BridgeService(repositories, dispatcher),
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");

    // Argument deltas are intentionally not a dispatch boundary anymore.
    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.function_call_arguments.done", name: "bridge_send_sms", call_id: "tool-sms", arguments: '{"trusted_contact_id":"contact-a","message":"Please call me."}',
    })));
    assert.equal(sends, 0);

    const toolResponse = {
      type: "response.done",
      response: {
        id: "response-tool",
        output: [{ type: "function_call", status: "completed", name: "bridge_send_sms", call_id: "tool-sms", arguments: '{"trusted_contact_id":"contact-a","message":"Please call me."}' }],
      },
    };
    realtime.emit("message", Buffer.from(JSON.stringify(toolResponse)));
    await new Promise((resolve) => setImmediate(resolve));
    realtime.emit("message", Buffer.from(JSON.stringify(toolResponse)));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends, 1);
    const sent = realtime.sent.slice(1).map((message) => JSON.parse(message) as { type: string; item?: { call_id?: string } });
    assert.deepEqual(sent.map((message) => message.type), ["conversation.item.create", "response.create"]);
    assert.equal(sent[0].item?.call_id, "tool-sms");
  } finally { closeDatabase(database); }
});

test("Shield tools dispatch only from completed response.done calls and preserve their privacy boundary", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550003333" });
  let assessments = 0;
  const sentSms: Array<{ to: string; body: string }> = [];
  const dispatcher = new ActionDispatcher(repositories, telephonyConfig, { messages: { create: async (input) => {
    sentSms.push({ to: input.to, body: input.body });
    return { sid: "SMshield", status: "queued" };
  } } });
  const shield = new ShieldService(repositories, "key", "safe", async () => {
    assessments += 1;
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ status: "pause_recommended", redFlags: ["urgency", "gift_card_payment"], safeNextStep: "verify_known_official_number" }) }) } as Response;
  }, dispatcher);
  const bridge = new BridgeService(repositories, dispatcher);
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, bridge, undefined, undefined, undefined, shield,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string; tools: Array<{ name: string }> } };
    assert.match(sessionUpdate.session.instructions, /Never state that something is definitely a scam/);
    assert.match(sessionUpdate.session.instructions, /Iris is speaking with Avery about something that feels urgent or suspicious\. Please check in with them when you can\./);
    assert.deepEqual(sessionUpdate.session.tools.map((tool) => tool.name).sort(), ["bridge_send_sms", "end_call", "shield_assess", "shield_send_alert"].sort());

    const assessmentArguments = '{"situation":"A caller claiming to be my bank says I must buy gift cards immediately."}';
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.function_call_arguments.done", name: "shield_assess", call_id: "shield-assess", arguments: assessmentArguments })));
    assert.equal(assessments, 0);

    const assessmentCall = { type: "response.done", response: { id: "response-shield", output: [{ type: "function_call", status: "completed", name: "shield_assess", call_id: "shield-assess", arguments: assessmentArguments }] } };
    realtime.emit("message", Buffer.from(JSON.stringify(assessmentCall)));
    realtime.emit("message", Buffer.from(JSON.stringify(assessmentCall)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(assessments, 1);
    assert.deepEqual(
      repositories.listEvents("person-a")
        .filter((event) => event.type === "shield.pause_offered")
        .map((event) => event.payload),
      [{}],
    );

    const alertCall = (callId: string, trustedContactId: string) => ({ type: "response.done", response: { id: `response-${callId}`, output: [{ type: "function_call", status: "completed", name: "shield_send_alert", call_id: callId, arguments: JSON.stringify({ trusted_contact_id: trustedContactId }) }] } });
    realtime.emit("message", Buffer.from(JSON.stringify(alertCall("shield-alert-unlisted", "other"))));
    realtime.emit("message", Buffer.from(JSON.stringify(alertCall("shield-alert-valid", "contact-a"))));
    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: { id: "response-shield-malformed", output: [{ type: "function_call", status: "completed", name: "shield_assess", call_id: "shield-assess-malformed", arguments: "not-json" }] },
    })));

    await new Promise((resolve) => setImmediate(resolve));
    const outputs = realtime.sent.slice(1)
      .filter((message) => JSON.parse(message).type === "conversation.item.create")
      .map((message) => JSON.parse(message) as { item: { call_id: string; output: string } })
      .map(({ item }) => ({ callId: item.call_id, result: JSON.parse(item.output) }))
      .sort((left, right) => left.callId.localeCompare(right.callId));
    assert.deepEqual(outputs, [
      { callId: "shield-assess", result: { status: "pause_recommended", redFlags: ["urgency", "gift_card_payment"], safeNextStep: "verify_known_official_number" } },
      { callId: "shield-alert-valid", result: { ok: true, contactName: "Robin" } },
      { callId: "shield-alert-unlisted", result: { ok: false, error: "unavailable_contact" } },
      { callId: "shield-assess-malformed", result: { ok: false, error: "invalid_arguments" } },
    ].sort((left, right) => left.callId.localeCompare(right.callId)));
    assert.deepEqual(sentSms, [{ to: "+15550003333", body: "Iris is speaking with Avery about something that feels urgent or suspicious. Please check in with them when you can." }]);
    assert.equal(repositories.listActionRequests("person-a").length, 1);
    assert.deepEqual(
      repositories.listEvents("person-a").filter((event) => event.type === "shield.alert_sent").map((event) => event.payload),
      [{ contactName: "Robin" }],
    );
  } finally { closeDatabase(database); }
});

test("completed tools always receive a result, including malformed and unsupported calls", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const dispatcher = new ActionDispatcher(repositories, telephonyConfig, { messages: { create: async () => ({ sid: "SM123", status: "queued" }) } });
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, undefined, undefined, new BridgeService(repositories, dispatcher),
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");

    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: {
        id: "response-tools",
        output: [
          { type: "function_call", status: "completed", name: "bridge_send_sms", call_id: "tool-malformed", arguments: "not-json" },
          { type: "function_call", status: "completed", name: "unconfigured_tool", call_id: "tool-unknown", arguments: "{}" },
        ],
      },
    })));

    const outputs = realtime.sent.slice(1)
      .filter((message) => JSON.parse(message).type === "conversation.item.create")
      .map((message) => JSON.parse(message) as { item: { call_id: string; output: string } });
    assert.deepEqual(outputs.map(({ item }) => ({ callId: item.call_id, result: JSON.parse(item.output) })), [
      { callId: "tool-malformed", result: { ok: false, error: "invalid_arguments" } },
      { callId: "tool-unknown", result: { ok: false, error: "unsupported_tool" } },
    ]);
    assert.equal(realtime.sent.slice(1).filter((message) => JSON.parse(message).type === "response.create").length, 2);
  } finally { closeDatabase(database); }
});

test("end_call waits for the farewell response, then finalizes through the existing call lifecycle", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const scheduler = new FakeScheduler();
  const summaries: Array<{ transcript: unknown[] }> = [];
  const configuredTelephony = { ...telephonyConfig, farewellCloseTimeoutMs: 77 };
  const manager = new OutboundCallManager(
    repositories, configuredTelephony, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    { process: async (input) => { summaries.push(input); } }, scheduler, 10_000, undefined, 10_000,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { instructions: string; tools: Array<{ name: string }> } };
    assert.match(sessionUpdate.session.instructions, /Never use it for silence, hesitation, or ambiguous language/);
    assert.equal(sessionUpdate.session.tools.some((tool) => tool.name === "end_call"), true);
    // A tentative remark in a transcript is never a local teardown signal.
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Maybe we can wrap up later." })));
    assert.equal(socket.closed, false);
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Goodbye, Iris." })));

    const endResponse = {
      type: "response.done",
      response: { id: "response-end-tool", output: [{ type: "function_call", status: "completed", name: "end_call", call_id: "tool-end", arguments: "{}" }] },
    };
    realtime.emit("message", Buffer.from(JSON.stringify(endResponse)));
    realtime.emit("message", Buffer.from(JSON.stringify(endResponse)));
    assert.equal(scheduler.scheduled?.delayMs, 77);
    assert.equal(socket.closed, false);
    assert.equal(realtime.sent.filter((message) => JSON.parse(message).type === "response.create").length, 1);

    // A non-tool response that predates the tool result cannot masquerade as
    // the farewell before response.created binds the newly requested response.
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { id: "response-stale", output: [] } })));
    assert.equal(socket.closed, false);

    // A second end request acknowledges its tool call but cannot create a
    // second farewell or a second call finalization.
    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: { id: "response-end-duplicate", output: [{ type: "function_call", status: "completed", name: "end_call", call_id: "tool-end-second", arguments: "{}" }] },
    })));
    assert.equal(realtime.sent.filter((message) => JSON.parse(message).type === "response.create").length, 1);

    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.created", response: { id: "response-farewell" } })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", response_id: "response-farewell", delta: "farewell-audio" })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.done", response_id: "response-farewell" })));
    assert.equal(socket.closed, false);
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { id: "response-farewell", output: [] } })));
    // OpenAI completion is not enough: wait for Twilio to acknowledge playback.
    assert.equal(socket.closed, false);
    const mark = socket.sent
      .map((message) => JSON.parse(message) as { event?: string; mark?: { name?: string } })
      .find((message) => message.event === "mark");
    assert.deepEqual(mark, { event: "mark", streamSid: "MZ123", mark: { name: "iris-farewell" } });
    socket.emit("message", Buffer.from(JSON.stringify({ event: "mark", streamSid: "MZ123", mark: { name: "iris-farewell" } })));

    assert.equal(socket.closed, true);
    assert.equal(repositories.listCalls("person-a")[0].status, "completed");
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "processing");
    assert.deepEqual(summaries, [{ callId, personId: "person-a", transcript: [
      { speaker: "user", text: "Maybe we can wrap up later." },
      { speaker: "user", text: "Goodbye, Iris." },
    ] }]);
  } finally { closeDatabase(database); }
});

test("end_call uses its farewell-only timeout when completion events never arrive", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const realtime = new FakeSocket();
  const scheduler = new FakeScheduler();
  const configuredTelephony = { ...telephonyConfig, farewellCloseTimeoutMs: 91 };
  const manager = new OutboundCallManager(
    repositories, configuredTelephony, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, scheduler, 10_000, undefined, 10_000,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: { id: "response-end-tool", output: [{ type: "function_call", status: "completed", name: "end_call", call_id: "tool-end", arguments: "{}" }] },
    })));
    assert.equal(scheduler.scheduled?.delayMs, 91);
    scheduler.scheduled?.callback();
    assert.equal(socket.closed, true);
    assert.equal(repositories.listCalls("person-a")[0].status, "completed");

    // Late farewell events cannot finalize the already-closed session again.
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { id: "response-farewell", output: [] } })));
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "call.completed").length, 1);
  } finally { closeDatabase(database); }
});

test("a failed end_call tool output arms its safety timeout and closes the call", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const realtime = new FakeSocket();
  const scheduler = new FakeScheduler();
  const configuredTelephony = { ...telephonyConfig, farewellCloseTimeoutMs: 91 };
  const manager = new OutboundCallManager(
    repositories, configuredTelephony, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, scheduler, 10_000, undefined, 10_000,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.throwOnSend = true;

    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: { id: "response-end-tool", output: [{ type: "function_call", status: "completed", name: "end_call", call_id: "tool-end", arguments: "{}" }] },
    })));
    assert.equal(scheduler.scheduled?.delayMs, 91);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.closed, true);
    assert.equal(repositories.listCalls("person-a")[0].status, "failed");
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "call.failed").length, 1);
  } finally { closeDatabase(database); }
});

test("handset hangup clears a pending farewell timeout through the normal close path", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const realtime = new FakeSocket();
  const scheduler = new FakeScheduler();
  const configuredTelephony = { ...telephonyConfig, farewellCloseTimeoutMs: 91 };
  const manager = new OutboundCallManager(
    repositories, configuredTelephony, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    undefined, scheduler, 10_000, undefined, 10_000,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({
      type: "response.done",
      response: { id: "response-end-tool", output: [{ type: "function_call", status: "completed", name: "end_call", call_id: "tool-end", arguments: "{}" }] },
    })));
    const farewellTimeout = scheduler.scheduled;
    const clearsBeforeHangup = scheduler.cleared;

    socket.emit("close");
    assert.equal(socket.closed, true);
    assert.equal(scheduler.cleared, clearsBeforeHangup + 1);
    assert.equal(repositories.listCalls("person-a")[0].status, "completed");
    farewellTimeout?.callback();
    assert.equal(repositories.listEvents("person-a").filter((event) => event.type === "call.completed").length, 1);
  } finally { closeDatabase(database); }
});

test("startup recovery ends known Twilio calls before releasing their local guard", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createCall({ id: "call-with-sid", personId: "person-a", status: "answered", providerCallId: "CAknown" });
  repositories.createPerson({ id: "person-b", displayName: "Blair", phoneE164: "+15550003333" });
  repositories.createCall({ id: "call-without-sid", personId: "person-b", status: "attempted" });
  const terminated: string[] = [];
  let providerCalls = 0;
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => { providerCalls += 1; return { sid: "CAnew" }; } } },
    () => new FakeSocket(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (providerCallId) => { terminated.push(providerCallId); },
  );
  try {
    assert.deepEqual(await manager.recoverInterruptedCalls(), ["call-with-sid"]);
    assert.deepEqual(terminated, ["CAknown"]);
    assert.equal(repositories.listCalls("person-a")[0].status, "failed");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "call.interrupted"), true);

    // No SID means Twilio may still have accepted the call before persistence.
    // Retain the guard rather than interrupting and risking a duplicate dial.
    assert.equal(repositories.listCalls("person-b")[0].status, "attempted");
    assert.equal(repositories.listEvents("person-b").some((event) => event.type === "call.interrupted"), false);
    assert.equal((await manager.startCall("person-b")).callId, "call-without-sid");
    assert.equal(providerCalls, 0);
  } finally { closeDatabase(database); }
});

test("startup recovery retains a call guard when Twilio termination is uncertain", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "answered", providerCallId: "CAunknown" });
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => ({ sid: "CAnew" }) } },
    () => new FakeSocket(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => { throw new Error("network unavailable"); },
  );
  try {
    assert.deepEqual(await manager.recoverInterruptedCalls(), []);
    assert.equal(repositories.listCalls("person-a")[0].status, "answered");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "call.interrupted"), false);
  } finally { closeDatabase(database); }
});

test("an unsolicited Realtime disconnect fails the call and skips summary", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const summaries: unknown[] = [];
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    { process: async (input) => { summaries.push(input); } },
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Half a sentence" })));

    // OpenAI/network drops mid-call before any Twilio terminal status arrives.
    realtime.emit("close");

    assert.equal(repositories.listCalls("person-a")[0].status, "failed");
    assert.deepEqual(summaries, []);
    assert.equal(socket.closed, true);
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "call.failed"), true);
  } finally { closeDatabase(database); }
});

test("a rejecting summary pipeline does not disrupt call finalization", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    { process: async () => { throw new Error("summary boom"); } },
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Please remember Ruth." })));
    manager.handleStatus(callId, "completed");
    socket.emit("close");
    // Let the rejected summary promise settle; it must be swallowed, not thrown.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(repositories.listCalls("person-a")[0].status, "completed");
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "unavailable");
  } finally { closeDatabase(database); }
});

test("a consented completed call without a summary processor becomes unavailable", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Remember Ruth." })));
    manager.handleStatus(callId, "completed");
    socket.emit("close");
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "unavailable");
  } finally { closeDatabase(database); }
});

test("a wrong Media Stream token cannot open a session", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const manager = new OutboundCallManager(
    repositories, telephonyConfig,
    { calls: { create: async () => ({ sid: "CA123" }) } },
    () => new FakeSocket(),
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({
      event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: "wrong" } },
    })));
    // An unauthenticated socket is closed without mutating the legitimate call.
    assert.equal(socket.closed, true);
    assert.equal(repositories.listCalls("person-a")[0].status, "attempted");
  } finally {
    closeDatabase(database);
  }
});

test("fallback finalization preserves final turns and is idempotent", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  const realtime = new FakeSocket();
  const scheduler = new FakeScheduler();
  const summaries: Array<{ transcript: unknown[] }> = [];
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } }, () => realtime,
    { process: async (input) => { summaries.push(input); } }, scheduler, 321,
  );
  try {
    const { callId } = await manager.startCall("person-a");
    const token = /streamToken" value="([^"]+)"/.exec(manager.twiml(callId) ?? "")?.[1];
    assert.ok(token);
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ event: "start", start: { streamSid: "MZ123", customParameters: { callId, streamToken: token } } })));
    realtime.emit("open");
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Please remember Ruth." })));
    manager.handleStatus(callId, "completed");
    assert.equal(scheduler.scheduled?.delayMs, 321);
    scheduler.scheduled?.callback();
    assert.equal(socket.closed, true);
    assert.equal(repositories.listCalls("person-a")[0].status, "completed");
    assert.deepEqual(summaries, [{ callId, personId: "person-a", transcript: [{ speaker: "user", text: "Please remember Ruth." }] }]);
    socket.emit("close");
    assert.equal(summaries.length, 1);
    // One clear for the handshake timer (on valid start) and one for the
    // finalization timer (on finish).
    assert.equal(scheduler.cleared, 2);
  } finally { closeDatabase(database); }
});

test("closes a media socket that never sends an authenticated start", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  const scheduler = new FakeScheduler();
  const manager = new OutboundCallManager(
    repositories, telephonyConfig, { calls: { create: async () => ({ sid: "CA123" }) } },
    () => new FakeSocket(), undefined, scheduler, 10_000, undefined, 5_000,
  );
  try {
    const socket = new FakeSocket();
    manager.acceptMediaSocket(socket);
    // Only the informational `connected` frame arrives; no authenticated start.
    socket.emit("message", Buffer.from(JSON.stringify({ event: "connected" })));
    assert.equal(socket.closed, false);
    assert.equal(scheduler.scheduled?.delayMs, 5_000);
    scheduler.scheduled?.callback();
    assert.equal(socket.closed, true);
  } finally { closeDatabase(database); }
});
