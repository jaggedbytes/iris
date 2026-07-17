import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";
import { ShieldService, type ShieldRequest } from "../src/shield.js";

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function setup() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "answered" });
  return { database, repositories };
}

test("Shield makes a strict ephemeral Terra assessment and records only a generic pause event", async () => {
  const { database, repositories } = setup();
  let requestInput: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  const situation = "Someone claiming to be my bank says I must buy gift cards now and read them a passcode.";
  const request: ShieldRequest = async (input, init) => {
    requestInput = input;
    requestInit = init;
    return response({ output_text: JSON.stringify({ status: "pause_recommended", redFlags: ["urgency", "gift_card_payment", "one_time_passcode", "impersonation"], safeNextStep: "verify_known_official_number" }) });
  };
  const shield = new ShieldService(repositories, "api-key", "stable-safety-id", request);
  try {
    const assessment = await shield.assess({ callId: "call-a", personId: "person-a", situation });
    assert.deepEqual(assessment, { status: "pause_recommended", redFlags: ["urgency", "gift_card_payment", "one_time_passcode", "impersonation"], safeNextStep: "verify_known_official_number" });
    assert.equal(requestInput, "https://api.openai.com/v1/responses");
    assert.equal(requestInit?.method, "POST");
    assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer api-key");
    assert.equal((requestInit?.headers as Record<string, string>)["OpenAI-Safety-Identifier"], "stable-safety-id");
    assert.ok(requestInit?.signal);
    const body = JSON.parse(requestInit?.body as string);
    assert.equal(body.model, "gpt-5.6-terra");
    assert.equal(body.store, false);
    assert.equal(body.safety_identifier, "stable-safety-id");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.properties.status.enum, ["pause_recommended", "insufficient_signal"]);
    assert.equal("uniqueItems" in body.text.format.schema.properties.redFlags, false);
    assert.equal(body.input[1].content, situation);

    const events = repositories.listEvents("person-a");
    assert.deepEqual(events.map((event) => ({ type: event.type, payload: event.payload })), [{ type: "shield.pause_offered", payload: {} }]);
    assert.equal(JSON.stringify(events).includes(situation), false);
    assert.equal(JSON.stringify(repositories.listCalls("person-a")).includes(situation), false);
  } finally {
    closeDatabase(database);
  }
});

test("Shield returns insufficient signal without a durable event, including under revoked summary consent", async () => {
  const { database, repositories } = setup();
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "revoked", source: "test" });
  let requests = 0;
  const shield = new ShieldService(repositories, "key", "safe", async () => {
    requests += 1;
    return response({ output_text: JSON.stringify({ status: "insufficient_signal", redFlags: [], safeNextStep: "none" }) });
  });
  try {
    assert.deepEqual(await shield.assess({ callId: "call-a", personId: "person-a", situation: "I received a phone call." }), { status: "insufficient_signal", redFlags: [], safeNextStep: null });
    assert.equal(requests, 1);
    assert.deepEqual(repositories.listEvents("person-a"), []);
  } finally {
    closeDatabase(database);
  }
});

test("Shield does not send empty or runaway situation summaries upstream", async () => {
  const { database, repositories } = setup();
  let requests = 0;
  const shield = new ShieldService(repositories, "key", "safe", async () => {
    requests += 1;
    return response({});
  });
  try {
    assert.deepEqual(await shield.assess({ callId: "call-a", personId: "person-a", situation: "   \n\t " }), { status: "insufficient_signal", redFlags: [], safeNextStep: null });
    assert.deepEqual(await shield.assess({ callId: "call-a", personId: "person-a", situation: "x".repeat(2_001) }), { status: "unavailable", redFlags: [], safeNextStep: null });
    assert.equal(requests, 0);
    assert.deepEqual(repositories.listEvents("person-a"), []);
  } finally {
    closeDatabase(database);
  }
});

test("Shield keeps refusals, malformed output, timeouts, and provider failures unavailable and durable-state free", async () => {
  const scenarios: Array<ShieldRequest> = [
    async () => response({ output: [{ content: [{ type: "refusal", refusal: "no" }] }] }),
    async () => response({ output_text: "{not JSON" }),
    async () => response({ output_text: JSON.stringify({ status: "pause_recommended", redFlags: [], safeNextStep: "verify_known_official_number" }) }),
    async () => response({ error: "upstream" }, false),
    async () => { throw new Error("timed out"); },
  ];
  for (const request of scenarios) {
    const { database, repositories } = setup();
    try {
      const result = await new ShieldService(repositories, "key", "safe", request).assess({ callId: "call-a", personId: "person-a", situation: "A caller says I must act right now." });
      assert.deepEqual(result, { status: "unavailable", redFlags: [], safeNextStep: null });
      assert.deepEqual(repositories.listEvents("person-a"), []);
    } finally {
      closeDatabase(database);
    }
  }
});
