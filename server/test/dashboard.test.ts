import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApp } from "../src/app.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

const adminToken = "dashboard-test-admin-token";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function createDashboardServer() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createPerson({ id: "person-b", displayName: "Blair" });
  repositories.createTrustedContact({
    id: "contact-a",
    personId: "person-a",
    displayName: "Robin",
    relationship: "daughter",
  });

  const app = createApp({
    dashboard: {
      repositories,
      adminToken,
      frontendOrigin: "http://localhost:5173",
    },
  });
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    database,
    repositories,
    close: () => {
      server.close();
      closeDatabase(database);
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("allows an admin to view a person overview", async () => {
  const fixture = await createDashboardServer();

  try {
    const response = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/overview`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { person: { id: string }; contacts: unknown[] };
    assert.equal(body.person.id, "person-a");
    assert.equal(body.contacts.length, 1);
  } finally {
    fixture.close();
  }
});

test("limits a trusted contact link to its person and granted scopes", async () => {
  const fixture = await createDashboardServer();

  try {
    fixture.repositories.createCall({
      id: "call-a",
      personId: "person-a",
      status: "completed",
    });
    fixture.repositories.completeCall({
      id: "call-a",
      status: "completed",
      summaryJson: JSON.stringify({ recap: "Talked about a garden." }),
    });
    fixture.repositories.createEvent({
      id: "event-a",
      personId: "person-a",
      type: "bridge.nudge_created",
      payload: { source: "test" },
    });
    fixture.repositories.grantAccess({
      id: "grant-a",
      personId: "person-a",
      trustedContactId: "contact-a",
      scopes: ["view_summaries"],
      tokenHash: hash("contact-token"),
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const permitted = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/overview`,
      { headers: { Authorization: "Bearer contact-token" } },
    );
    assert.equal(permitted.status, 200);
    const permittedBody = (await permitted.json()) as {
      calls: Array<{ id: string }>;
      contacts: unknown[];
      events: unknown[];
      actions: unknown[];
    };
    assert.deepEqual(permittedBody.calls.map((call) => call.id), ["call-a"]);
    assert.deepEqual(permittedBody.contacts, []);
    assert.deepEqual(permittedBody.events, []);
    assert.deepEqual(permittedBody.actions, []);

    const denied = await fetch(
      `${fixture.url}/api/dashboard/people/person-b/overview`,
      { headers: { Authorization: "Bearer contact-token" } },
    );
    assert.equal(denied.status, 403);
  } finally {
    fixture.close();
  }
});

test("creates a hashed magic link and revocation removes access", async () => {
  const fixture = await createDashboardServer();

  try {
    const malformed = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/magic-links`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trustedContactId: "contact-a" }),
      },
    );
    assert.equal(malformed.status, 400);

    const created = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/magic-links`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trustedContactId: "contact-a", scopes: ["view_events"] }),
      },
    );
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      grant: { id: string };
      magicLink: string;
    };
    const accessToken = new URL(body.magicLink).searchParams.get("access");
    assert.ok(accessToken);

    const principal = await fetch(`${fixture.url}/api/dashboard/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(principal.status, 200);

    const revoked = await fetch(
      `${fixture.url}/api/dashboard/access-grants/${body.grant.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(revoked.status, 204);

    const afterRevocation = await fetch(`${fixture.url}/api/dashboard/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(afterRevocation.status, 401);
  } finally {
    fixture.close();
  }
});
