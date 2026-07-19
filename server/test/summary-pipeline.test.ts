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
  let resolveResponse: ((response: Response) => void) | undefined;
  const request = async () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
  try {
    // The call is completed before the summary lands; persisting the summary
    // must not move ended_at (which would inflate the recorded duration).
    repositories.completeCall({ id: "call-a", status: "completed" });
    const endedAt = repositories.listCalls("person-a")[0].endedAt;
    assert.ok(endedAt);
    const processing = new CallSummaryPipeline(repositories, "key", "safe-id", request).process({
      callId: "call-a", personId: "person-a",
      transcript: [
        { speaker: "user", text: "My friend Ruth lives nearby." },
        { speaker: "assistant", text: "You should message Ruth today." },
      ],
    });
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "processing");
    resolveResponse?.(new Response(JSON.stringify({ output_text: JSON.stringify({
      status: "complete", recap: "Avery talked about visiting Ruth.", facts: ["Avery has a friend named Ruth."],
      people: [{ name: "Ruth", relationshipOrContext: "Avery's friend" }], unresolvedTopics: ["Plan a visit with Ruth."],
      recallAnchor: "  your plans to visit Ruth  ",
      careSummary: null,
    }) }), { status: 200 }));
    await processing;
    const summary = JSON.parse(repositories.listCalls("person-a")[0].summaryJson!) as { facts: string[]; recallAnchor: string | null };
    assert.deepEqual(summary.facts, ["Avery has a friend named Ruth."]);
    assert.equal(summary.recallAnchor, "your plans to visit Ruth");
    assert.equal(repositories.findLatestRecallAnchor("person-a"), "your plans to visit Ruth");
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "ready");
    assert.equal(repositories.listCalls("person-a")[0].endedAt, endedAt);
    assert.deepEqual(repositories.listEvents("person-a").find((event) => event.type === "call.summary_ready")?.payload, {});
    assert.equal(JSON.stringify(repositories.listEvents("person-a")).includes("My friend Ruth lives nearby."), false);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%transcript%'").all();
    assert.deepEqual(tables, []);
  } finally { closeDatabase(database); }
});

test("uses one extraction for a care-only summary when both consents are active", async () => {
  const { database, repositories } = fixture();
  repositories.recordConsent({ id: "care-consent", personId: "person-a", kind: "care_summary_sharing", status: "granted", source: "test" });
  let requests = 0;
  let requestBody: Record<string, unknown> | undefined;
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", async (_input, init) => {
      requests += 1;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        status: "complete", recap: "", facts: [], people: [], unresolvedTopics: [], recallAnchor: null,
        careSummary: {
          recap: "Avery described a difficult night.",
          moodAndConcerns: ["Avery said they had a nightmare."],
          irisSuggestedNextSteps: ["Iris suggested having some breakfast."],
        },
      }) }), { status: 200 });
    }).process({
      callId: "call-a", personId: "person-a", transcript: [{ speaker: "user", text: "I had a nightmare." }],
    });

    assert.equal(requests, 1);
    assert.equal(requestBody?.model, "gpt-5.6-terra");
    assert.equal(requestBody?.store, false);
    assert.match(JSON.stringify(requestBody), /dashboard-only/);
    const summary = JSON.parse(repositories.listCalls("person-a")[0].summaryJson!) as { careSummary: { recap: string }; facts: unknown[] };
    assert.equal(summary.careSummary.recap, "Avery described a difficult night.");
    assert.deepEqual(summary.facts, []);
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "ready");
    assert.deepEqual(repositories.listMemories("person-a"), []);
  } finally { closeDatabase(database); }
});

test("retains no care section without sharing consent and discards recognizable identifiers", async () => {
  const { database, repositories } = fixture();
  let requests = 0;
  const responseFor = (careSummary: unknown) => async () => {
    requests += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      status: "complete", recap: "Avery talked about gardening.", facts: ["Avery gardens."], people: [], unresolvedTopics: [], recallAnchor: "your garden",
      careSummary,
    }) }), { status: 200 });
  };
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor({
      recap: "Avery felt worried.", moodAndConcerns: ["Avery felt worried."], irisSuggestedNextSteps: ["Iris suggested a break."],
    })).process({ callId: "call-a", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }] });
    assert.equal(requests, 1);
    assert.equal((JSON.parse(repositories.listCalls("person-a")[0].summaryJson!) as { careSummary: unknown }).careSummary, null);

    repositories.recordConsent({ id: "care-consent", personId: "person-a", kind: "care_summary_sharing", status: "granted", source: "test" });
    repositories.createCall({ id: "call-sensitive", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor({
      recap: "Avery mentioned a number.", moodAndConcerns: ["Avery said 123-45-6789."], irisSuggestedNextSteps: [],
    })).process({ callId: "call-sensitive", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }] });
    const sensitive = JSON.parse(repositories.listCalls("person-a").find((call) => call.id === "call-sensitive")!.summaryJson!) as { careSummary: unknown };
    assert.equal(sensitive.careSummary, null);
    assert.equal(JSON.stringify(sensitive).includes("123-45-6789"), false);

    repositories.createCall({ id: "call-card", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor({
      recap: "Avery mentioned a number.", moodAndConcerns: ["Avery said 4111 1111 1111 1111."], irisSuggestedNextSteps: [],
    })).process({ callId: "call-card", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }] });
    const card = JSON.parse(repositories.listCalls("person-a").find((call) => call.id === "call-card")!.summaryJson!) as { careSummary: unknown };
    assert.equal(card.careSummary, null);
    assert.equal(JSON.stringify(card).includes("4111 1111 1111 1111"), false);

    const discardedIdentifiers = [
      { id: "call-email", marker: "avery@example.com", care: { recap: "Avery shared contact info.", moodAndConcerns: ["Avery said avery@example.com."], irisSuggestedNextSteps: [] } },
      { id: "call-phone", marker: "+15551234567", care: { recap: "Avery shared a phone number.", moodAndConcerns: ["Avery said +15551234567."], irisSuggestedNextSteps: [] } },
      { id: "call-address", marker: "123 Main Street", care: { recap: "Avery shared where they were.", moodAndConcerns: ["Avery said 123 Main Street."], irisSuggestedNextSteps: [] } },
      { id: "call-dob", marker: "03/14/1948", care: { recap: "Avery shared a birthday.", moodAndConcerns: ["Avery said date of birth 03/14/1948."], irisSuggestedNextSteps: [] } },
    ] as const;
    for (const fixtureCase of discardedIdentifiers) {
      repositories.createCall({ id: fixtureCase.id, personId: "person-a", status: "completed" });
      await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor(fixtureCase.care)).process({
        callId: fixtureCase.id, personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }],
      });
      const stored = JSON.parse(repositories.listCalls("person-a").find((call) => call.id === fixtureCase.id)!.summaryJson!) as { careSummary: unknown };
      assert.equal(stored.careSummary, null);
      assert.equal(JSON.stringify(stored).includes(fixtureCase.marker), false);
    }

    repositories.createCall({ id: "call-street-name", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor({
      recap: "Avery walked near Main Street.",
      moodAndConcerns: ["Avery felt unsettled near Main Street."],
      irisSuggestedNextSteps: ["Iris suggested resting at home."],
    })).process({ callId: "call-street-name", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }] });
    const streetName = JSON.parse(repositories.listCalls("person-a").find((call) => call.id === "call-street-name")!.summaryJson!) as { careSummary: { recap: string } | null };
    assert.equal(streetName.careSummary?.recap, "Avery walked near Main Street.");

    repositories.createCall({ id: "call-malformed-care", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", responseFor({
      recap: "", moodAndConcerns: "not an array", irisSuggestedNextSteps: [],
    })).process({ callId: "call-malformed-care", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }] });
    const malformedCare = repositories.listCalls("person-a").find((call) => call.id === "call-malformed-care");
    assert.equal(malformedCare?.summaryState, "ready");
    assert.equal((JSON.parse(malformedCare!.summaryJson!) as { careSummary: unknown }).careSummary, null);
    assert.equal(requests, 9);
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
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "not_requested");
    assert.equal(repositories.findLatestRecallAnchor("person-a"), null);
  } finally { closeDatabase(database); }
});

test("leaves an empty transcript not_requested without contacting extraction", async () => {
  const { database, repositories } = fixture();
  let requested = false;
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => { requested = true; return new Response(); }).process({
      callId: "call-a", personId: "person-a", transcript: [],
    });
    assert.equal(requested, false);
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "not_requested");
  } finally { closeDatabase(database); }
});

test("does not save refused, malformed, or insufficient extraction", async () => {
  const { database, repositories } = fixture();
  try {
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => new Response(JSON.stringify({ output_text: '{"status":"insufficient_signal","recap":"","facts":[],"people":[],"unresolvedTopics":[],"recallAnchor":null,"careSummary":null}' }), { status: 200 })).process({
      callId: "call-a", personId: "person-a", transcript: [{ speaker: "user", text: "um" }],
    });
    assert.equal(repositories.listCalls("person-a")[0].summaryJson, null);
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "unavailable");
    assert.deepEqual(repositories.listEvents("person-a").find((event) => event.type === "call.summary_unavailable")?.payload, {});

    repositories.createCall({ id: "call-refused", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => new Response(JSON.stringify({ output: [{ content: [{ refusal: "Cannot summarize." }] }] }), { status: 200 })).process({
      callId: "call-refused", personId: "person-a", transcript: [{ speaker: "user", text: "private words" }],
    });
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-refused")?.summaryState, "unavailable");
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-refused")?.summaryJson, null);

    repositories.createCall({ id: "call-malformed", personId: "person-a", status: "completed" });
    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      status: "complete", recap: "Avery talked about a garden.", facts: [], people: [], unresolvedTopics: [], recallAnchor: 42, careSummary: null,
    }) }), { status: 200 })).process({
      callId: "call-malformed", personId: "person-a", transcript: [{ speaker: "user", text: "I garden." }],
    });
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-malformed")?.summaryState, "unavailable");
    assert.equal(repositories.findLatestRecallAnchor("person-a"), null);
  } finally { closeDatabase(database); }
});

test("ready summary state is terminal and finalize rolls back partial memory writes", () => {
  const { database, repositories } = fixture();
  try {
    repositories.completeCall({ id: "call-a", status: "completed", summaryState: "processing" });
    assert.equal(repositories.finalizeCallSummary({
      callId: "call-a",
      personId: "person-a",
      summaryJson: JSON.stringify({ status: "complete", recap: "Garden talk.", facts: [], people: [], unresolvedTopics: [], recallAnchor: "your garden" }),
      readyEventId: "event-ready",
      memories: [
        { id: "memory-a", category: "durable_fact", payload: { fact: "Avery gardens." } },
        { id: "memory-anchor", category: "recall_anchor", payload: { anchor: "your garden" } },
      ],
    }), true);
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "ready");
    assert.equal(repositories.updateCallSummaryState({ id: "call-a", summaryState: "unavailable" }), false);
    assert.equal(repositories.listCalls("person-a")[0].summaryState, "ready");
    assert.equal(repositories.listEvents("person-a").some((event) => event.type === "call.summary_unavailable"), false);

    repositories.createCall({ id: "call-b", personId: "person-a", status: "completed" });
    repositories.completeCall({ id: "call-b", status: "completed", summaryState: "processing" });
    const duplicateId = "memory-dup";
    assert.throws(() => repositories.finalizeCallSummary({
      callId: "call-b",
      personId: "person-a",
      summaryJson: JSON.stringify({ status: "complete", recap: "Should not stick.", facts: [], people: [], unresolvedTopics: [], recallAnchor: "your garden" }),
      readyEventId: "event-ready-b",
      memories: [
        { id: "memory-anchor-b", category: "recall_anchor", payload: { anchor: "your garden" } },
        { id: duplicateId, category: "durable_fact", payload: { fact: "one" } },
        { id: duplicateId, category: "durable_fact", payload: { fact: "two" } },
      ],
    }));
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-b")?.summaryJson, null);
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-b")?.summaryState, "processing");
    assert.equal(repositories.listMemories("person-a").some((memory) => memory.payload_json.includes("Should not stick")), false);
    assert.equal(repositories.findLatestRecallAnchor("person-a"), "your garden");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?").get("memory-anchor-b") as { count: number }).count,
      0,
    );
    assert.equal(repositories.listEvents("person-a").some((event) => event.id === "event-ready-b"), false);
  } finally { closeDatabase(database); }
});

test("a null recall anchor does not remove an earlier valid anchor", async () => {
  const { database, repositories } = fixture();
  try {
    repositories.createMemory({
      id: "memory-old-anchor", personId: "person-a", sourceCallId: "call-a",
      category: "recall_anchor", payload: { anchor: "your garden plans" },
    });
    repositories.createCall({ id: "call-b", personId: "person-a", status: "completed" });

    await new CallSummaryPipeline(repositories, "key", "safe-id", async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        status: "complete", recap: "Avery shared a short update.", facts: [], people: [], unresolvedTopics: [], recallAnchor: null, careSummary: null,
      }),
    }), { status: 200 })).process({
      callId: "call-b", personId: "person-a", transcript: [{ speaker: "user", text: "Nothing much today." }],
    });

    assert.equal(repositories.findLatestRecallAnchor("person-a"), "your garden plans");
    assert.equal(repositories.listCalls("person-a").find((call) => call.id === "call-b")?.summaryState, "ready");
  } finally { closeDatabase(database); }
});
