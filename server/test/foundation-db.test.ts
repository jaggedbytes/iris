import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  DEFAULT_FAREWELL_CLOSE_TIMEOUT_MS,
  loadDashboardConfig,
  loadFoundationConfig,
  loadTelephonyConfig,
} from "../src/config.js";
import { closeDatabase, createDatabase, createRepositories, migrate } from "../src/db/index.js";
import { migrations } from "../src/db/schema.js";

function createTestRepositories() {
  const database = createDatabase(":memory:");
  return { database, repositories: createRepositories(database) };
}

test("scopes calls to their owning person", () => {
  const { database, repositories } = createTestRepositories();

  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createPerson({ id: "person-b", displayName: "Blair" });
    repositories.createCall({
      id: "call-a",
      personId: "person-a",
      status: "completed",
    });
    repositories.createCall({
      id: "call-b",
      personId: "person-b",
      status: "completed",
    });

    assert.deepEqual(
      repositories.listCalls("person-a").map((call) => call.id),
      ["call-a"],
    );
    assert.deepEqual(
      repositories.listCalls("person-b").map((call) => call.id),
      ["call-b"],
    );
  } finally {
    closeDatabase(database);
  }
});

test("reserves one active outbound call per person until it reaches a terminal status", () => {
  const { database, repositories } = createTestRepositories();

  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    const first = repositories.reserveOutboundCall({ id: "call-a", personId: "person-a" });
    const duplicate = repositories.reserveOutboundCall({ id: "call-b", personId: "person-a" });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.call.id, "call-a");

    repositories.completeCall({ id: "call-a", status: "completed" });
    const next = repositories.reserveOutboundCall({ id: "call-b", personId: "person-a" });
    assert.equal(next.created, true);
    assert.equal(next.call.id, "call-b");
  } finally {
    closeDatabase(database);
  }
});

test("scopes active outbound-call reuse to the requesting trusted contact", () => {
  const { database, repositories } = createTestRepositories();

  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
    repositories.createTrustedContact({ id: "contact-b", personId: "person-a", displayName: "Sam", relationship: "son", phoneE164: "+15550003333" });

    const first = repositories.reserveOutboundCall({ id: "call-a", personId: "person-a", requestedByContactId: "contact-a" });
    assert.equal(first.created, true);
    assert.equal(first.conflict, false);
    assert.equal(first.call.requestedByContactId, "contact-a");

    // Same contact re-requesting is idempotent reuse, not a conflict.
    const sameContact = repositories.reserveOutboundCall({ id: "call-b", personId: "person-a", requestedByContactId: "contact-a" });
    assert.equal(sameContact.created, false);
    assert.equal(sameContact.conflict, false);
    assert.equal(sameContact.call.id, "call-a");

    // A different contact must not inherit the in-flight call.
    const otherContact = repositories.reserveOutboundCall({ id: "call-c", personId: "person-a", requestedByContactId: "contact-b" });
    assert.equal(otherContact.created, false);
    assert.equal(otherContact.conflict, true);
    assert.equal(otherContact.call.id, "call-a");

    // An admin (no requester) also conflicts with a contact-owned call.
    const admin = repositories.reserveOutboundCall({ id: "call-d", personId: "person-a" });
    assert.equal(admin.created, false);
    assert.equal(admin.conflict, true);
    assert.equal(admin.call.id, "call-a");
  } finally {
    closeDatabase(database);
  }
});

test("uses the latest summary-retention consent state", () => {
  const { database, repositories } = createTestRepositories();

  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.recordConsent({
      id: "consent-granted",
      personId: "person-a",
      kind: "summary_retention",
      status: "granted",
      source: "demo",
    });
    assert.equal(repositories.hasActiveConsent("person-a", "summary_retention"), true);

    repositories.recordConsent({
      id: "consent-revoked",
      personId: "person-a",
      kind: "summary_retention",
      status: "revoked",
      source: "demo",
    });
    assert.equal(repositories.hasActiveConsent("person-a", "summary_retention"), false);
  } finally {
    closeDatabase(database);
  }
});

test("stores summary-only call records with no transcript column", () => {
  const { database, repositories } = createTestRepositories();

  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createCall({
      id: "call-a",
      personId: "person-a",
      status: "answered",
    });
    repositories.completeCall({
      id: "call-a",
      status: "completed",
      summaryJson: JSON.stringify({ recap: "Talked about gardening." }),
    });

    const columns = database
      .prepare("PRAGMA table_info(calls)")
      .all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name.includes("transcript")), false);
    assert.deepEqual(repositories.listCalls("person-a")[0]?.summaryJson, JSON.stringify({ recap: "Talked about gardening." }));
    assert.equal(repositories.listCalls("person-a")[0]?.summaryState, "ready");
  } finally {
    closeDatabase(database);
  }
});

test("005 summary_state migration backfills ready for calls that already have a summary", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const record = database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (migration.id === "005_call_summary_state") break;
      database.exec(migration.sql);
      record.run(migration.id, "2026-07-17T00:00:00.000Z");
    }
    database.prepare("INSERT INTO people (id, display_name, created_at) VALUES (?, ?, ?)").run("person-a", "Avery", "2026-07-17T00:00:00.000Z");
    database.prepare(
      `INSERT INTO calls (id, person_id, provider_call_id, status, started_at, ended_at, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("call-with-summary", "person-a", null, "completed", "2026-07-17T00:00:00.000Z", "2026-07-17T00:01:00.000Z", '{"recap":"Avery gardens."}');
    database.prepare(
      `INSERT INTO calls (id, person_id, provider_call_id, status, started_at, ended_at, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("call-without-summary", "person-a", null, "completed", "2026-07-17T00:02:00.000Z", "2026-07-17T00:03:00.000Z", null);

    migrate(database);

    assert.equal(
      (database.prepare("SELECT summary_state FROM calls WHERE id = ?").get("call-with-summary") as { summary_state: string }).summary_state,
      "ready",
    );
    assert.equal(
      (database.prepare("SELECT summary_state FROM calls WHERE id = ?").get("call-without-summary") as { summary_state: string }).summary_state,
      "not_requested",
    );
  } finally {
    database.close();
  }
});

test("007 memory category migration preserves legacy rows and constrains new categories", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const record = database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (migration.id === "007_memory_categories") break;
      database.exec(migration.sql);
      record.run(migration.id, "2026-07-17T00:00:00.000Z");
    }
    database.prepare("INSERT INTO people (id, display_name, created_at) VALUES (?, ?, ?)").run("person-a", "Avery", "2026-07-17T00:00:00.000Z");
    database.prepare(
      `INSERT INTO memories (id, person_id, source_call_id, category, payload_json, confidence, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("memory-legacy", "person-a", null, "durable_fact", '{"fact":"Avery gardens."}', 0.9, null, "2026-07-17T00:00:00.000Z");
    database.prepare(
      "INSERT INTO memories (id, person_id, category, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("memory-person", "person-a", "named_person", '{"name":"Ruth"}', "2026-07-17T00:00:01.000Z");
    database.prepare(
      "INSERT INTO memories (id, person_id, category, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("memory-topic", "person-a", "unresolved_topic", '{"topic":"Garden plans"}', "2026-07-17T00:00:02.000Z");
    database.prepare(
      "INSERT INTO memories (id, person_id, category, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("memory-unsupported", "person-a", "mood_inference", '{"mood":"tired"}', "2026-07-17T00:00:03.000Z");

    migrate(database);

    assert.deepEqual(
      database.prepare("SELECT * FROM memories WHERE id = ?").get("memory-legacy"),
      {
        id: "memory-legacy", person_id: "person-a", source_call_id: null,
        category: "durable_fact", payload_json: '{"fact":"Avery gardens."}', confidence: 0.9,
        expires_at: null, created_at: "2026-07-17T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      database.prepare("SELECT category FROM memories WHERE id IN (?, ?) ORDER BY id").all("memory-person", "memory-topic"),
      [{ category: "named_person" }, { category: "unresolved_topic" }],
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?").get("memory-unsupported") as { count: number }).count,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count,
      3,
    );
    database.prepare(
      "INSERT INTO memories (id, person_id, category, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("memory-anchor", "person-a", "recall_anchor", '{"anchor":"your garden plans"}', "2026-07-17T00:00:01.000Z");
    assert.throws(
      () => database.prepare(
        "INSERT INTO memories (id, person_id, category, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("memory-unknown", "person-a", "unknown", "{}", "2026-07-17T00:00:02.000Z"),
      /CHECK constraint failed/,
    );
    const indexes = database.prepare("PRAGMA index_list(memories)").all() as Array<{ name: string }>;
    assert.equal(indexes.some((index) => index.name === "idx_memories_person_category_created"), true);
  } finally {
    database.close();
  }
});

test("008 enrollment migration preserves action dispatch records and adds append-only SMS enrollment data", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const record = database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (migration.id === "008_trusted_contact_sms_opt_in") break;
      database.exec(migration.sql);
      record.run(migration.id, "2026-07-18T00:00:00.000Z");
    }
    database.prepare("INSERT INTO people (id, display_name, created_at) VALUES (?, ?, ?)").run("person-a", "Avery", "2026-07-18T00:00:00.000Z");
    database.prepare("INSERT INTO trusted_contacts (id, person_id, display_name, relationship, phone_e164, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("contact-a", "person-a", "Robin", "daughter", "+15550002222", "2026-07-18T00:00:00.000Z");
    database.prepare(
      `INSERT INTO action_requests
       (id, person_id, feature, action_type, payload_json, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("action-a", "person-a", "bridge", "sms", "{}", "approved", "action-key", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z");
    database.prepare(
      "INSERT INTO messages (id, person_id, action_request_id, direction, provider_message_id, delivery_status, created_at) VALUES (?, ?, ?, 'outbound', ?, ?, ?)",
    ).run("message-a", "person-a", "action-a", "SMpreserved", "queued", "2026-07-18T00:00:00.000Z");
    database.prepare(
      "INSERT INTO action_dispatch_outbox (action_request_id, state, provider_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("action-a", "needs_review", "SMpreserved", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z");

    migrate(database);

    assert.deepEqual(
      database.prepare("SELECT feature, status, idempotency_key FROM action_requests WHERE id = ?").get("action-a"),
      { feature: "bridge", status: "approved", idempotency_key: "action-key" },
    );
    assert.deepEqual(
      database.prepare("SELECT action_request_id, provider_message_id FROM messages WHERE id = ?").get("message-a"),
      { action_request_id: "action-a", provider_message_id: "SMpreserved" },
    );
    assert.deepEqual(
      database.prepare("SELECT action_request_id, state FROM action_dispatch_outbox WHERE action_request_id = ?").get("action-a"),
      { action_request_id: "action-a", state: "needs_review" },
    );
    database.prepare(
      `INSERT INTO action_requests
       (id, person_id, feature, action_type, payload_json, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'enrollment', 'sms_confirmation', '{}', 'approved', ?, ?, ?)`,
    ).run("action-enrollment", "person-a", "enrollment-key", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z");
    assert.throws(
      () => database.prepare(
        `INSERT INTO action_requests
         (id, person_id, feature, action_type, payload_json, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'unknown', 'x', '{}', 'approved', ?, ?, ?)`,
      ).run("action-unknown", "person-a", "unknown-key", "2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"),
      /CHECK constraint failed/,
    );
    const consentColumns = database.prepare("PRAGMA table_info(trusted_contact_sms_consents)").all() as Array<{ name: string }>;
    assert.equal(consentColumns.some((column) => column.name === "phone_e164"), true);
    assert.throws(
      () => database.prepare(
        `INSERT INTO trusted_contact_sms_consents
         (id, trusted_contact_id, phone_e164, status, source, occurred_at)
         VALUES (?, ?, ?, 'granted', 'unknown', ?)`,
      ).run("consent-invalid-source", "contact-a", "+15550002222", "2026-07-18T00:00:00.000Z"),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("tracks trusted-contact SMS consent and one-time invitations without crossing people", () => {
  const { database, repositories } = createTestRepositories();
  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createPerson({ id: "person-b", displayName: "Blair" });
    repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
    repositories.createTrustedContact({ id: "contact-b", personId: "person-b", displayName: "Sam", relationship: "friend", phoneE164: "+15550003333" });
    repositories.recordTrustedContactSmsConsent({
      id: "sms-granted", trustedContactId: "contact-a", phoneE164: "+15550002222",
      status: "granted", source: "web_form", disclosureVersion: "2026-07-18",
    });
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "granted");
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-b"), null);
    repositories.recordTrustedContactSmsConsent({
      id: "sms-revoked", trustedContactId: "contact-a", phoneE164: "+15550002222",
      status: "revoked", source: "inbound_stop",
    });
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "revoked");
    assert.equal(repositories.listTrustedContactSmsConsents("contact-b").length, 0);

    const invitation = repositories.createSmsOptInInvitation({
      id: "invite-a", personId: "person-a", trustedContactId: "contact-a",
      tokenHash: "hash-a", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(repositories.findActiveSmsOptInInvitation("hash-a")?.id, invitation.id);
    assert.equal(repositories.consumeSmsOptInInvitation(invitation.id), true);
    assert.equal(repositories.consumeSmsOptInInvitation(invitation.id), false);
    assert.equal(repositories.findActiveSmsOptInInvitation("hash-a"), null);
    repositories.createSmsOptInInvitation({
      id: "invite-expired", personId: "person-b", trustedContactId: "contact-b",
      tokenHash: "hash-expired", expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(repositories.findActiveSmsOptInInvitation("hash-expired"), null);
    assert.throws(
      () => repositories.createSmsOptInInvitation({
        id: "invite-cross-person", personId: "person-a", trustedContactId: "contact-b",
        tokenHash: "hash-cross-person", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      /does not belong/,
    );
  } finally {
    closeDatabase(database);
  }
});

test("validates the durable foundation environment", () => {
  assert.deepEqual(
    loadFoundationConfig({
      IRIS_DATABASE_PATH: ":memory:",
      IRIS_DEMO_PERSON_ID: "person-test",
    }),
    {
      databasePath: ":memory:",
      demoPersonId: "person-test",
    },
  );

  assert.throws(
    () => loadFoundationConfig({ IRIS_DATABASE_PATH: "" }),
    /IRIS_DATABASE_PATH must not be empty/,
  );

  assert.deepEqual(loadDashboardConfig({ IRIS_ADMIN_TOKEN: "test-admin-token" }), {
    adminToken: "test-admin-token",
    frontendOrigin: "http://localhost:5173",
  });
  assert.deepEqual(
    loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", FRONTEND_ORIGIN: "https://iris.example.com/app" }),
    { adminToken: "t", frontendOrigin: "https://iris.example.com" },
  );
  assert.throws(() => loadDashboardConfig({}), /IRIS_ADMIN_TOKEN must be configured/);
  assert.throws(
    () => loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", NODE_ENV: "production" }),
    /FRONTEND_ORIGIN must be configured in production/,
  );
  assert.throws(
    () => loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", FRONTEND_ORIGIN: "not a url" }),
    /FRONTEND_ORIGIN must be a valid http\(s\) URL/,
  );
  assert.throws(
    () => loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", FRONTEND_ORIGIN: "ftp://iris.example.com" }),
    /FRONTEND_ORIGIN must use the http or https protocol/,
  );
});

test("validates the optional farewell-close timeout for phone calls", () => {
  const requiredTelephonyEnvironment = {
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "test-auth-token",
    TWILIO_PHONE_NUMBER: "+15550001111",
    IRIS_PUBLIC_BASE_URL: "https://iris.example.test",
    OPENAI_API_KEY: "test-openai-key",
  };

  assert.equal(
    loadTelephonyConfig(requiredTelephonyEnvironment).farewellCloseTimeoutMs,
    DEFAULT_FAREWELL_CLOSE_TIMEOUT_MS,
  );
  assert.equal(
    loadTelephonyConfig({
      ...requiredTelephonyEnvironment,
      IRIS_FAREWELL_CLOSE_TIMEOUT_MS: "12000",
    }).farewellCloseTimeoutMs,
    12_000,
  );

  for (const value of ["999", "30001", "not-a-number", "8000.5"]) {
    assert.throws(
      () => loadTelephonyConfig({ ...requiredTelephonyEnvironment, IRIS_FAREWELL_CLOSE_TIMEOUT_MS: value }),
      /IRIS_FAREWELL_CLOSE_TIMEOUT_MS must be an integer between 1000 and 30000 milliseconds/,
    );
  }
});
