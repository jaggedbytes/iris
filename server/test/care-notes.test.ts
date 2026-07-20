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
      updatedAt: repositories.listCareNotes("person-a")[0]!.updatedAt,
      deletedAt: null,
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
    database.prepare("UPDATE care_notes SET updated_at = created_at WHERE id = ?").run("note-a");
    assert.equal(repositories.lastCheckInAt("person-a", true), "2026-07-20T13:00:00.000Z");
    assert.equal(repositories.lastCheckInAt("person-a", false), "2026-07-20T13:00:00.000Z");
  } finally {
    closeDatabase(database);
  }
});

test("soft-deleted notes are retained internally but excluded from notes and last check-in", () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  try {
    repositories.createPerson({ id: "person-a", displayName: "Avery" });
    repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
    database.prepare("UPDATE calls SET started_at = ?, ended_at = ? WHERE id = ?")
      .run("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z", "call-a");
    repositories.createCareNote({
      id: "note-a", personId: "person-a", authorRole: "operator", authorDisplayName: "Operator", body: "Original note.",
    });
    database.prepare("UPDATE care_notes SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-07-20T13:00:00.000Z", "2026-07-20T13:00:00.000Z", "note-a");

    const updated = repositories.updateCareNote({ id: "note-a", body: "Corrected note." });
    assert.equal(updated?.body, "Corrected note.");
    assert.equal(updated?.createdAt, "2026-07-20T13:00:00.000Z");
    assert.ok(updated?.updatedAt);
    assert.equal(updated?.deletedAt, null);
    assert.equal(repositories.lastCheckInAt("person-a", true), "2026-07-20T13:00:00.000Z");

    assert.equal(repositories.deleteCareNote("note-a"), true);
    assert.deepEqual(repositories.listCareNotes("person-a"), []);
    assert.equal(repositories.lastCheckInAt("person-a", true), "2026-07-20T12:00:00.000Z");
    assert.equal(repositories.getCareNote("note-a")?.body, "Corrected note.");
    assert.ok(repositories.getCareNote("note-a")?.deletedAt);
  } finally {
    closeDatabase(database);
  }
});

test("care-note scope authorizes posting and controls last-check-in visibility", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
    fixture.repositories.recordConsent({ id: "retention", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
    fixture.repositories.recordConsent({ id: "care-sharing", personId: "person-a", kind: "care_summary_sharing", status: "granted", source: "test" });
    fixture.repositories.completeCall({
      id: "call-a", status: "completed", summaryJson: JSON.stringify({
        recap: "Private memory.", facts: [], people: [], unresolvedTopics: [], recallAnchor: null,
        careSummary: {
          recap: "Avery enjoyed a family call.", moodAndConcerns: [],
          irisSuggestedNextSteps: ["Iris suggested making time for a favorite show."],
        },
      }),
    });
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

    const whitespaceOnly = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer notes-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "   \n\t  " }),
    });
    assert.equal(whitespaceOnly.status, 400);

    const tooLong = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer notes-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "a".repeat(1001) }),
    });
    assert.equal(tooLong.status, 400);

    const notesOnlyBefore = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-token" },
    });
    assert.equal((await notesOnlyBefore.json() as { lastCheckInAt: string | null }).lastCheckInAt, null);

    const notesAndSummaries = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-and-summaries-token" },
    });
    const notesAndSummariesBody = await notesAndSummaries.json() as {
      lastCheckInAt: string | null;
      notes: unknown[];
      calls: Array<{ careSummary: { recap: string } | null }>;
    };
    assert.ok(notesAndSummariesBody.lastCheckInAt);
    assert.deepEqual(notesAndSummariesBody.notes, []);
    assert.equal(notesAndSummariesBody.calls[0]?.careSummary?.recap, "Avery enjoyed a family call.");

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
    const createdBody = await created.json() as { note: {
      body: string; authorDisplayName: string; authorRelationship: string | null; updatedAt: string; canEdit: boolean;
    } };
    assert.deepEqual(createdBody.note, {
      body: "I checked in after dinner.", authorDisplayName: "Robin", authorRelationship: "daughter",
      id: createdBody.note.id, authorRole: "trusted_contact", createdAt: createdBody.note.createdAt,
      updatedAt: createdBody.note.updatedAt, canEdit: true,
    });

    const notesOnlyAfter = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-token" },
    });
    const notesOnlyAfterBody = await notesOnlyAfter.json() as {
      lastCheckInAt: string | null;
      notes: Array<{ authorDisplayName: string; body: string }>;
      calls: unknown[];
    };
    assert.ok(notesOnlyAfterBody.lastCheckInAt);
    assert.deepEqual(notesOnlyAfterBody.calls, []);
    assert.deepEqual(notesOnlyAfterBody.notes.map((note) => ({ authorDisplayName: note.authorDisplayName, body: note.body })), [
      { authorDisplayName: "Robin", body: "I checked in after dinner." },
      { authorDisplayName: "Operator", body: "Operator checked in too." },
    ]);
    assert.equal(JSON.stringify(notesOnlyAfterBody).includes("authorTrustedContactId"), false);

    const summariesOnly = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer summaries-token" },
    });
    const summariesOnlyBody = await summariesOnly.json() as { calls: Array<{ careSummary: { recap: string } | null }> } & Record<string, unknown>;
    assert.equal("lastCheckInAt" in summariesOnlyBody, false);
    assert.equal("notes" in summariesOnlyBody, false);
    assert.equal(summariesOnlyBody.calls[0]?.careSummary?.recap, "Avery enjoyed a family call.");

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

test("only a note author may edit or delete their note", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.createTrustedContact({
      id: "contact-b", personId: "person-a", displayName: "Casey", relationship: "neighbor",
    });
    fixture.repositories.grantAccess({
      id: "grant-a", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["care_notes", "view_summaries"], tokenHash: hash("contact-a-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-b", personId: "person-a", trustedContactId: "contact-b",
      scopes: ["care_notes", "view_summaries"], tokenHash: hash("contact-b-token"), expiresAt: futureExpiry(),
    });
    const create = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer contact-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "I checked in this afternoon." }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { note: { id: string; canEdit: boolean; updatedAt: string } };
    assert.equal(created.note.canEdit, true);
    assert.ok(created.note.updatedAt);

    const crossEdit = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${created.note.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer contact-b-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Not mine." }),
    });
    assert.equal(crossEdit.status, 403);
    const ownEdit = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${created.note.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer contact-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "I checked in after lunch." }),
    });
    assert.equal(ownEdit.status, 200);
    const ownEditBody = await ownEdit.json() as { note: { body: string; canEdit: boolean; updatedAt: string } };
    assert.equal(ownEditBody.note.body, "I checked in after lunch.");
    assert.equal(ownEditBody.note.canEdit, true);
    assert.ok(ownEditBody.note.updatedAt);

    const operatorNote = fixture.repositories.createCareNote({
      id: "operator-note", personId: "person-a", authorRole: "operator", authorDisplayName: "Operator", body: "Operator update.",
    });
    const trustedEditsOperator = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${operatorNote.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer contact-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Nope." }),
    });
    assert.equal(trustedEditsOperator.status, 403);
    const operatorEditsTrusted = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${created.note.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Nope." }),
    });
    assert.equal(operatorEditsTrusted.status, 403);
    const operatorEdit = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${operatorNote.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Corrected operator update." }),
    });
    assert.equal(operatorEdit.status, 200);

    const crossDelete = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${created.note.id}`, {
      method: "DELETE", headers: { Authorization: "Bearer contact-b-token" },
    });
    assert.equal(crossDelete.status, 403);
    const ownDelete = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${created.note.id}`, {
      method: "DELETE", headers: { Authorization: "Bearer contact-a-token" },
    });
    assert.equal(ownDelete.status, 204);
    assert.equal(fixture.repositories.getCareNote(created.note.id)?.deletedAt === null, false);

    fixture.repositories.createCall({ id: "call-a", personId: "person-a", status: "completed" });
    const createThreadNote = await fetch(`${fixture.url}/api/dashboard/people/person-a/calls/call-a/notes`, {
      method: "POST",
      headers: { Authorization: "Bearer contact-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "A call-specific update." }),
    });
    assert.equal(createThreadNote.status, 201);
    const threadNote = await createThreadNote.json() as { note: { id: string; canEdit: boolean } };
    assert.equal(threadNote.note.canEdit, true);
    const editThreadNote = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${threadNote.note.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer contact-a-token", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "A corrected call-specific update." }),
    });
    assert.equal(editThreadNote.status, 200);
    const deleteThreadNote = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${threadNote.note.id}`, {
      method: "DELETE", headers: { Authorization: "Bearer contact-a-token" },
    });
    assert.equal(deleteThreadNote.status, 204);
    assert.deepEqual(fixture.repositories.listCareNotesForCall("person-a", "call-a"), []);

    fixture.repositories.deleteTrustedContact("contact-b");
    const deletedAuthorNote = fixture.repositories.createCareNote({
      id: "deleted-author-note", personId: "person-a", authorRole: "trusted_contact", authorTrustedContactId: "contact-a",
      authorDisplayName: "Robin", authorRelationship: "daughter", body: "Keep my attribution.",
    });
    fixture.repositories.deleteTrustedContact("contact-a");
    assert.equal(fixture.repositories.getCareNote(deletedAuthorNote.id)?.authorTrustedContactId, null);
    const adminCannotEditDeletedAuthor = await fetch(`${fixture.url}/api/dashboard/people/person-a/notes/${deletedAuthorNote.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "No longer editable." }),
    });
    assert.equal(adminCannotEditDeletedAuthor.status, 403);
  } finally {
    fixture.close();
  }
});

test("Home notes include only general notes and the newest visible call's active notes", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.createCall({ id: "older-call", personId: "person-a", status: "completed" });
    fixture.repositories.createCall({ id: "newer-call", personId: "person-a", status: "completed" });
    fixture.database.prepare("UPDATE calls SET started_at = ? WHERE id = ?")
      .run("2026-07-20T10:00:00.000Z", "older-call");
    fixture.database.prepare("UPDATE calls SET started_at = ? WHERE id = ?")
      .run("2026-07-20T11:00:00.000Z", "newer-call");
    fixture.repositories.createCareNote({
      id: "general-note", personId: "person-a", authorRole: "operator", authorDisplayName: "Operator", body: "General update.",
    });
    fixture.repositories.createCareNote({
      id: "older-note", personId: "person-a", callId: "older-call", authorRole: "operator", authorDisplayName: "Operator", body: "Older-call note.",
    });
    fixture.repositories.createCareNote({
      id: "newer-note", personId: "person-a", callId: "newer-call", authorRole: "operator", authorDisplayName: "Operator", body: "Newest-call note.",
    });
    fixture.repositories.createCareNote({
      id: "deleted-newer-note", personId: "person-a", callId: "newer-call", authorRole: "operator", authorDisplayName: "Operator", body: "Hidden note.",
    });
    fixture.repositories.deleteCareNote("deleted-newer-note");
    fixture.repositories.grantAccess({
      id: "notes-only", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["care_notes"], tokenHash: hash("notes-only-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "notes-and-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["care_notes", "view_summaries"], tokenHash: hash("notes-and-summaries-home-token"), expiresAt: futureExpiry(),
    });

    const notesOnly = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-only-token" },
    });
    const notesOnlyBody = await notesOnly.json() as { notes: Array<{ id: string }>; calls: unknown[] };
    assert.deepEqual(notesOnlyBody.notes.map((note) => note.id), ["general-note"]);
    assert.deepEqual(notesOnlyBody.calls, []);

    const full = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer notes-and-summaries-home-token" },
    });
    const fullBody = await full.json() as {
      notes: Array<{ id: string; canEdit: boolean; updatedAt: string } & Record<string, unknown>>;
    };
    assert.deepEqual(fullBody.notes.map((note) => note.id), ["general-note", "newer-note"]);
    assert.equal(fullBody.notes.every((note) => note.canEdit === false && typeof note.updatedAt === "string"), true);
    assert.equal(JSON.stringify(fullBody.notes).includes("callId"), false);
    assert.equal(JSON.stringify(fullBody.notes).includes("deletedAt"), false);
  } finally {
    fixture.close();
  }
});
