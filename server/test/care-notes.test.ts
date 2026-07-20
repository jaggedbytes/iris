import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApp } from "../src/app.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

const adminToken = "care-notes-admin-token";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const futureExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

async function createDashboardServer() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createPerson({ id: "person-b", displayName: "Blair" });
  repositories.createTrustedContact({
    id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter",
  });
  const app = createApp({
    dashboard: {
      repositories,
      adminToken,
      frontendOrigin: "http://localhost:5173",
      demoPersonId: "person-a",
    },
  });
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    database,
    repositories,
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.close();
      closeDatabase(database);
    },
  };
}

test("care notes stay person-scoped and retain trusted-contact attribution after deletion", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createPerson({ id: "person-b", displayName: "Blair" });
    repositories.createTrustedContact({
      id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter",
    });
    repositories.createCareNote({
      id: "note-a", personId: "person-a", authorRole: "trusted_contact", authorTrustedContactId: "contact-a",
      authorDisplayName: "Robin", authorRelationship: "daughter", body: "I called after dinner.",
    });
    let invalidAuthorError: unknown;
    try {
      repositories.createCareNote({
        id: "invalid-operator", personId: "person-a", authorRole: "operator", authorTrustedContactId: "contact-a",
        authorDisplayName: "Operator", body: "Invalid author shape.",
      });
    } catch (error) {
      invalidAuthorError = error;
    }
    assert.ok(invalidAuthorError && typeof invalidAuthorError === "object" && "code" in invalidAuthorError);
    assert.equal(invalidAuthorError.code, "SQLITE_CONSTRAINT_CHECK");

    assert.deepEqual(repositories.listCareNotes("person-b"), []);
    assert.equal(repositories.deleteTrustedContact("contact-a"), true);
    assert.deepEqual(repositories.listCareNotes("person-a"), [{
      id: "note-a", personId: "person-a", authorRole: "trusted_contact", authorTrustedContactId: null,
      authorDisplayName: "Robin", authorRelationship: "daughter", body: "I called after dinner.",
      createdAt: repositories.listCareNotes("person-a")[0]!.createdAt,
    }]);
  } finally {
    closeDatabase(database);
  }
});

test("last check-in uses the newest completed call or note and falls back to a completed call start", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
    database.prepare("UPDATE calls SET started_at = ?, ended_at = NULL WHERE id = ?")
      .run("2026-07-20T12:00:00.000Z", "call-a");
    assert.equal(repositories.lastCheckInAt("person-a", true), "2026-07-20T12:00:00.000Z");

    repositories.createCareNote({
      id: "note-a", personId: "person-a", authorRole: "operator", authorDisplayName: "Operator",
      body: "Reached out after lunch.",
    });
    database.prepare("UPDATE care_notes SET created_at = ? WHERE id = ?")
      .run("2026-07-20T13:00:00.000Z", "note-a");
    assert.equal(repositories.lastCheckInAt("person-a", true), "2026-07-20T13:00:00.000Z");
    assert.equal(repositories.lastCheckInAt("person-a", false), "2026-07-20T13:00:00.000Z");
  } finally {
    closeDatabase(database);
  }
});

test("care-note scope authorizes posting and controls last-check-in visibility", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
    fixture.repositories.completeCall({ id: "call-a", status: "completed" });
    fixture.repositories.grantAccess({
      id: "grant-notes", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["care_notes"], tokenHash: hash("notes-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-notes-and-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["care_notes", "view_summaries"], tokenHash: hash("notes-and-summaries-token"), expiresAt: futureExpiry(),
    });

    const legacy = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer summaries-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "I checked in." }),
    });
    assert.equal(legacy.status, 403);

    const notesOnlyBefore = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-token" },
    });
    assert.equal((await notesOnlyBefore.json() as { lastCheckInAt: string | null }).lastCheckInAt, null);

    const notesAndSummaries = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-and-summaries-token" },
    });
    assert.ok((await notesAndSummaries.json() as { lastCheckInAt: string | null }).lastCheckInAt);

    const adminCreated = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Operator checked in too." }),
    });
    assert.equal(adminCreated.status, 201);
    const adminNote = (await adminCreated.json() as { note: {
      id: string; authorRole: string; authorDisplayName: string; authorRelationship: unknown; body: string; createdAt: string;
    } }).note;
    assert.equal(adminNote.authorRole, "operator");
    assert.equal(adminNote.authorDisplayName, "Operator");
    assert.equal(adminNote.authorRelationship, null);
    assert.equal(adminNote.body, "Operator checked in too.");
    assert.ok(adminNote.id);
    assert.ok(adminNote.createdAt);

    const created = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer notes-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "  I checked in after dinner.  " }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { note: { body: string; authorDisplayName: string; authorRelationship: string | null } };
    assert.deepEqual(createdBody.note, {
      body: "I checked in after dinner.", authorDisplayName: "Robin", authorRelationship: "daughter",
      id: createdBody.note.id, authorRole: "trusted_contact", createdAt: createdBody.note.createdAt,
    });

    const notesOnlyAfter = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-token" },
    });
    assert.ok((await notesOnlyAfter.json() as { lastCheckInAt: string | null }).lastCheckInAt);

    const summariesOnly = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer summaries-token" },
    });
    assert.equal("lastCheckInAt" in (await summariesOnly.json() as Record<string, unknown>), false);

    const crossPerson = await fetch(`${fixture.url}/api/dashboard/people/person-b/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer notes-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Not allowed." }),
    });
    assert.equal(crossPerson.status, 403);

    const magicLink = await fetch(`${fixture.url}/api/dashboard/people/person-a/magic-links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ trustedContactId: "contact-a", scopes: ["care_notes"] }),
    });
    assert.equal(magicLink.status, 201);
  } finally {
    fixture.close();
  }
});
