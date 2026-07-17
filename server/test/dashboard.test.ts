import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApp } from "../src/app.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";
import { ActiveCallConflictError } from "../src/telephony/outbound.js";

const adminToken = "dashboard-test-admin-token";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Grants must stay valid whenever the suite runs, so derive expiry from the
// current clock instead of a hard-coded (eventually past) calendar date.
const futureExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

async function createDashboardServer(options: { startOutboundCall?: (input: { personId: string; checkInRequester?: { trustedContactId: string; displayName: string } }) => Promise<{ callId: string }> } = {}) {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery", phoneE164: "+15550009999" });
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
      demoPersonId: "person-a",
      startOutboundCall: options.startOutboundCall,
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

test("permits check-in calls for admins and request_check_in trusted contacts", async () => {
  const startedFor: Array<{ personId: string; checkInRequester?: { trustedContactId: string; displayName: string } }> = [];
  const fixture = await createDashboardServer({
    startOutboundCall: async (input) => {
      startedFor.push(input);
      return { callId: "call-started" };
    },
  });

  try {
    fixture.repositories.grantAccess({
      id: "grant-checkin", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["request_check_in"], tokenHash: hash("checkin-token"),
      expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"),
      expiresAt: futureExpiry(),
    });

    const adminResponse = await fetch(`${fixture.url}/api/dashboard/people/person-a/calls`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminResponse.status, 202);

    const scopedContact = await fetch(`${fixture.url}/api/dashboard/people/person-a/calls`, {
      method: "POST", headers: { Authorization: "Bearer checkin-token" },
    });
    assert.equal(scopedContact.status, 202);

    const unscopedContact = await fetch(`${fixture.url}/api/dashboard/people/person-a/calls`, {
      method: "POST", headers: { Authorization: "Bearer summaries-token" },
    });
    assert.equal(unscopedContact.status, 403);

    assert.deepEqual(startedFor, [
      { personId: "person-a", checkInRequester: undefined },
      { personId: "person-a", checkInRequester: { trustedContactId: "contact-a", displayName: "Robin" } },
    ]);
  } finally {
    fixture.close();
  }
});

test("returns a conflict when another requester already has a call in progress", async () => {
  const fixture = await createDashboardServer({
    startOutboundCall: async () => {
      throw new ActiveCallConflictError("call-in-progress");
    },
  });

  try {
    fixture.repositories.grantAccess({
      id: "grant-checkin", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["request_check_in"], tokenHash: hash("checkin-token"),
      expiresAt: futureExpiry(),
    });

    const response = await fetch(`${fixture.url}/api/dashboard/people/person-a/calls`, {
      method: "POST", headers: { Authorization: "Bearer checkin-token" },
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /already in progress/i);
  } finally {
    fixture.close();
  }
});

test("allows an admin to view a person overview", async () => {
  const fixture = await createDashboardServer();

  try {
    const response = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/overview`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { person: { id: string; phoneE164: string | null }; contacts: unknown[] };
    assert.equal(body.person.id, "person-a");
    assert.equal(body.person.phoneE164, "+15550009999");
    assert.equal(body.contacts.length, 1);
  } finally {
    fixture.close();
  }
});

test("projects dashboard data without SMS, provider, transcript, or audit fields", async () => {
  const fixture = await createDashboardServer();
  const secretSmsBody = "Private SMS body must never reach the dashboard";
  const secretPhone = "+15551234567";
  const secretProviderId = "SM-private-provider-id";
  const secretTranscript = "private raw transcript words";

  try {
    fixture.repositories.createCall({
      id: "call-private", personId: "person-a", providerCallId: "CA-private-provider-id", status: "completed",
    });
    fixture.repositories.completeCall({
      id: "call-private", status: "completed", summaryJson: JSON.stringify({ recap: "A safe recap." }),
    });
    fixture.repositories.createActionRequest({
      id: "action-private", personId: "person-a", feature: "bridge", actionType: "sms", idempotencyKey: "private-action",
      payload: { to: secretPhone, body: secretSmsBody },
    });
    fixture.repositories.createEvent({
      id: "event-private", personId: "person-a", type: "call.completed",
      payload: { providerMessageId: secretProviderId, transcript: secretTranscript, body: secretSmsBody, to: secretPhone },
    });
    fixture.repositories.createEvent({
      id: "event-safe", personId: "person-a", type: "bridge.sms_sent",
      payload: { contactName: "Robin", actionId: "action-private", providerMessageId: secretProviderId },
    });

    const response = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      calls: Array<Record<string, unknown>>;
      events: Array<{ type: string; payload: unknown }>;
      actions: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(body);
    for (const value of [secretSmsBody, secretPhone, secretProviderId, secretTranscript, "CA-private-provider-id"]) {
      assert.equal(serialized.includes(value), false);
    }
    assert.equal("providerCallId" in body.calls[0], false);
    assert.equal("payload" in body.actions[0], false);
    assert.deepEqual(body.events.find((event) => event.type === "call.completed")?.payload, {});
    assert.deepEqual(body.events.find((event) => event.type === "bridge.sms_sent")?.payload, { contactName: "Robin" });
  } finally {
    fixture.close();
  }
});

test("shares only a current call state with a check-in-only trusted contact", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.createCall({ id: "call-active", personId: "person-a", status: "attempted" });
    fixture.repositories.grantAccess({
      id: "grant-checkin", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["request_check_in"], tokenHash: hash("checkin-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"), expiresAt: futureExpiry(),
    });

    const checkinResponse = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer checkin-token" },
    });
    const checkinBody = (await checkinResponse.json()) as { activeCall: { id: string; status: string } | null; calls: unknown[] };
    assert.deepEqual(checkinBody.activeCall, { id: "call-active", status: "attempted", startedAt: fixture.repositories.listCalls("person-a")[0].startedAt });
    assert.deepEqual(checkinBody.calls, []);

    const summariesResponse = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer summaries-token" },
    });
    const summariesBody = (await summariesResponse.json()) as { activeCall: unknown; calls: Array<{ id: string }> };
    assert.equal(summariesBody.activeCall, null);
    assert.deepEqual(summariesBody.calls.map((call) => call.id), ["call-active"]);
  } finally { fixture.close(); }
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
      expiresAt: futureExpiry(),
    });

    const permitted = await fetch(
      `${fixture.url}/api/dashboard/people/person-a/overview`,
      { headers: { Authorization: "Bearer contact-token" } },
    );
    assert.equal(permitted.status, 200);
    const permittedBody = (await permitted.json()) as {
      person: { id: string; phoneE164: string | null };
      calls: Array<{ id: string }>;
      contacts: unknown[];
      events: unknown[];
      actions: unknown[];
    };
    assert.equal(permittedBody.person.id, "person-a");
    assert.equal(permittedBody.person.phoneE164, null);
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
    const accessToken = new URLSearchParams(
      new URL(body.magicLink).hash.replace(/^#/, ""),
    ).get("access");
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
