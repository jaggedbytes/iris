import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";
import { CallSummaryPipeline } from "../src/summary.js";

function fixture() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
  repositories.recordConsent({ id: "consent-a", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
  return { database, repositories };
}

test("persists only validated user-stated summary memory", async () => {
  const { database, repositories } = fixture();
  const request = async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    status: "complete", recap: "Avery talked about visiting Ruth.", facts: ["Avery has a friend named Ruth."],
    people: [{ name: "Ruth", relationshipOrContext: "Avery's friend" }], unresolvedTopics: ["Plan a visit with Ruth."],
  }) }), { status: 200 });
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", request).process({
      callId: "call-a", personId: "person-a",
      transcript: [
        { speaker: "user", text: "My friend Ruth lives nearby." },
        { speaker: "assistant", text: "You should message Ruth today." },
      ],
    });
    const summary = JSON.parse(repositories.listCalls("person-a")[0].summaryJson!) as { facts: string[] };
    assert.deepEqual(summary.facts, ["Avery has a friend named Ruth."]);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%transcript%'").all();
    assert.deepEqual(tables, []);
  } finally { closeDatabase(database); }
});

test("does not call extraction or save anything without active consent", async () => {
  const { database, repositories } = fixture();
  repositories.recordConsent({ id: "consent-revoked", personId: "person-a", kind: "summary_retention", status: "revoked", source: "test" });
  let requested = false;
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => { requested = true; return new Response(); }).process({
      callId: "call-a", personId: "person-a", transcript: [{ speaker: "user", text: "private words" }],
    });
    assert.equal(requested, false);
    assert.equal(repositories.listCalls("person-a")[0].summaryJson, null);
  } finally { closeDatabase(database); }
});

test("does not save refused, malformed, or insufficient extraction", async () => {
  const { database, repositories } = fixture();
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => new Response(JSON.stringify({ output_text: '{"status":"insufficient_signal","recap":"","facts":[],"people":[],"unresolvedTopics":[]}' }), { status: 200 })).process({
      callId: "call-a", personId: "person-a", transcript: [{ speaker: "user", text: "um" }],
    });
    assert.equal(repositories.listCalls("person-a")[0].summaryJson, null);
  } finally { closeDatabase(database); }
});
