import assert from "node:assert/strict";
import test from "node:test";

import { loadDashboardConfig, loadFoundationConfig } from "../src/config.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

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
    () => loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", FRONTEND_ORIGIN: "not a url" }),
    /FRONTEND_ORIGIN must be a valid http\(s\) URL/,
  );
  assert.throws(
    () => loadDashboardConfig({ IRIS_ADMIN_TOKEN: "t", FRONTEND_ORIGIN: "ftp://iris.example.com" }),
    /FRONTEND_ORIGIN must use the http or https protocol/,
  );
});
