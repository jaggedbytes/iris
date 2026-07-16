import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDatabase, createRepositories, closeDatabase } from "../src/db/index.js";
import { OutboundCallManager } from "../src/telephony/outbound.js";
import type { SocketLike } from "../src/telephony/call-session.js";

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.emit("close"); }
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
  const requestedCalls: Record<string, unknown>[] = [];
  const realtime = new FakeSocket();
  const manager = new OutboundCallManager(
    repositories,
    telephonyConfig,
    { calls: { create: async (input) => { requestedCalls.push(input); return { sid: "CA123" }; } } },
    () => realtime,
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
    const sessionUpdate = JSON.parse(realtime.sent[0]) as { session: { audio: { input: { format: { type: string } } } } };
    assert.equal(sessionUpdate.session.audio.input.format.type, "audio/pcmu");
    assert.equal(realtime.sent.length, 1);
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    assert.deepEqual(JSON.parse(realtime.sent[1]), { type: "input_audio_buffer.append", audio: "ulaw-before-realtime-opens" });

    socket.emit("message", Buffer.from(JSON.stringify({ event: "media", media: { payload: "ulaw-from-phone" } })));
    assert.deepEqual(JSON.parse(realtime.sent[2]), { type: "input_audio_buffer.append", audio: "ulaw-from-phone" });
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: "ulaw-from-iris" })));
    assert.deepEqual(JSON.parse(socket.sent[0]), { event: "media", streamSid: "MZ123", media: { payload: "ulaw-from-iris" } });
    realtime.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
    assert.deepEqual(JSON.parse(socket.sent[1]), { event: "clear", streamSid: "MZ123" });

    socket.emit("close");
    const call = repositories.listCalls("person-a")[0];
    assert.equal(call.status, "completed");
    assert.equal(call.summaryJson, null);
    const eventTypes = repositories.listEvents("person-a").map((event) => event.type);
    assert.deepEqual(eventTypes.sort(), ["call.attempted", "call.answered", "call.completed", "call.stream_started"].sort());
  } finally {
    closeDatabase(database);
  }
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
    assert.equal(repositories.listCalls("person-a")[0].status, "failed");
  } finally {
    closeDatabase(database);
  }
});
