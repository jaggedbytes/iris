import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDatabase, createRepositories, closeDatabase } from "../src/db/index.js";
import { OutboundCallManager, type CallScheduler } from "../src/telephony/outbound.js";
import { friendlyRequesterToken, type SocketLike } from "../src/telephony/call-session.js";

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
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

test("family-requested calls retain the display name and use a friendly spoken token", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550002222" });
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async () => ({ sid: "CA123" }) } },
    () => realtime,
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
    async (providerCallId) => { terminated.push(providerCallId); },
  );
  try {
    assert.deepEqual(await manager.recoverInterruptedCalls(), ["call-with-sid", "call-without-sid"]);
    assert.deepEqual(terminated, ["CAknown"]);
    assert.equal(repositories.listCalls("person-a")[0].status, "failed");
    assert.equal(repositories.listCalls("person-b")[0].status, "failed");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "call.interrupted"), true);
    assert.equal(repositories.listEvents("person-b").some((event) => event.type === "call.interrupted"), true);
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
