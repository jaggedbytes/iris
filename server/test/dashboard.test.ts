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
    const body = (await response.json()) as {
      person: { id: string; phoneE164: string | null; phoneNumberStatus: string };
      contacts: Array<{
        smsOptInStatus: string;
        optInLinkState: string;
        confirmationState: string;
        dashboardGrant: { id: string; createdAt: string; expiresAt: string } | null;
      }>;
    };
    assert.equal(body.person.id, "person-a");
    assert.equal(body.person.phoneE164, "+15550009999");
    assert.equal(body.person.phoneNumberStatus, "configured");
    assert.equal(body.contacts.length, 1);
    assert.equal(body.contacts[0]?.smsOptInStatus, "not_opted_in");
    assert.equal(body.contacts[0]?.optInLinkState, "none");
    assert.equal(body.contacts[0]?.confirmationState, "not_requested");
    assert.equal(body.contacts[0]?.dashboardGrant, null);
  } finally {
    fixture.close();
  }
});

test("allows an admin to remove every person including the last enrollment", async () => {
  const fixture = await createDashboardServer();
  try {
    const removed = await fetch(`${fixture.url}/api/dashboard/people/person-b`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(removed.status, 204);
    assert.equal(fixture.repositories.getPerson("person-b"), null);

    const removedLast = await fetch(`${fixture.url}/api/dashboard/people/person-a`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(removedLast.status, 204);
    assert.equal(fixture.repositories.getPerson("person-a"), null);
    assert.equal(fixture.repositories.listPeople().length, 0);
  } finally {
    fixture.close();
  }
});

test("allows an admin to add or correct a person's phone number", async () => {
  const fixture = await createDashboardServer();
  try {
    const duplicateCreate = await fetch(`${fixture.url}/api/dashboard/people`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Casey", phoneE164: "+15550009999" }),
    });
    assert.equal(duplicateCreate.status, 409);
    assert.match(((await duplicateCreate.json()) as { error: string }).error, /already used by an enrolled person/i);

    const added = await fetch(`${fixture.url}/api/dashboard/people/person-b/phone`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phoneE164: "+15550008888" }),
    });
    assert.equal(added.status, 200);
    assert.equal(fixture.repositories.getPerson("person-b")?.phoneE164, "+15550008888");

    const corrected = await fetch(`${fixture.url}/api/dashboard/people/person-b/phone`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phoneE164: "+15550007777" }),
    });
    assert.equal(corrected.status, 200);
    assert.equal(fixture.repositories.getPerson("person-b")?.phoneE164, "+15550007777");

    const duplicate = await fetch(`${fixture.url}/api/dashboard/people/person-b/phone`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phoneE164: "+15550009999" }),
    });
    assert.equal(duplicate.status, 409);
    assert.match(((await duplicate.json()) as { error: string }).error, /already used by an enrolled person/i);
  } finally {
    fixture.close();
  }
});

test("keeps trusted-contact phone numbers unique and reports conflicts", async () => {
  const fixture = await createDashboardServer();
  try {
    const headers = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
    const created = await fetch(`${fixture.url}/api/dashboard/people/person-b/trusted-contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Casey", relationship: "friend", phoneE164: "+15550008888" }),
    });
    assert.equal(created.status, 201);

    const sameAsEnrolledPerson = await fetch(`${fixture.url}/api/dashboard/people/person-a/trusted-contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Drew", relationship: "friend", phoneE164: "+15550009999" }),
    });
    assert.equal(sameAsEnrolledPerson.status, 409);
    assert.match(
      ((await sameAsEnrolledPerson.json()) as { error: string }).error,
      /cannot use the enrolled person's phone number/i,
    );

    // Same phone may be reused by a trusted contact for a different enrolled person.
    const sharedAcrossPeople = await fetch(`${fixture.url}/api/dashboard/people/person-a/trusted-contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Morgan", relationship: "neighbor", phoneE164: "+15550008888" }),
    });
    assert.equal(sharedAcrossPeople.status, 201);

    // Within one person, contact phones stay unique.
    const duplicateWithinPerson = await fetch(`${fixture.url}/api/dashboard/people/person-a/trusted-contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Lee", relationship: "friend", phoneE164: "+15550008888" }),
    });
    assert.equal(duplicateWithinPerson.status, 409);
    assert.match(((await duplicateWithinPerson.json()) as { error: string }).error, /already used by a trusted contact/i);

    const duplicateEdit = await fetch(`${fixture.url}/api/dashboard/people/person-a/trusted-contacts/contact-a/phone`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ phoneE164: "+15550008888" }),
    });
    assert.equal(duplicateEdit.status, 409);

    // A different enrolled person may still share another family's trusted-contact number.
    const personSharingTrustedContactPhone = await fetch(`${fixture.url}/api/dashboard/people`, {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Jordan", phoneE164: "+15550008888" }),
    });
    assert.equal(personSharingTrustedContactPhone.status, 201);

    // An enrolled person cannot take a phone already used by their own trusted contact.
    const ownContactPhone = await fetch(`${fixture.url}/api/dashboard/people/person-b/phone`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ phoneE164: "+15550008888" }),
    });
    assert.equal(ownContactPhone.status, 409);
    assert.match(
      ((await ownContactPhone.json()) as { error: string }).error,
      /already used by a trusted contact for this person/i,
    );

    const duplicatePersonEdit = await fetch(`${fixture.url}/api/dashboard/people/person-b/phone`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ phoneE164: "+15550009999" }),
    });
    assert.equal(duplicatePersonEdit.status, 409);
    assert.match(
      ((await duplicatePersonEdit.json()) as { error: string }).error,
      /already used by an enrolled person/i,
    );
  } finally {
    fixture.close();
  }
});

test("limits consent attestation to admins and requires retention before care sharing", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"), expiresAt: futureExpiry(),
    });
    const headers = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
    const denied = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/summary_retention`, {
      method: "POST", headers: { Authorization: "Bearer summaries-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "granted", operatorAttested: true }),
    });
    assert.equal(denied.status, 403);

    const missingAttestation = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/summary_retention`, {
      method: "POST", headers, body: JSON.stringify({ status: "granted", operatorAttested: false }),
    });
    assert.equal(missingAttestation.status, 400);

    const careWithoutRetention = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/care_summary_sharing`, {
      method: "POST", headers, body: JSON.stringify({ status: "granted", operatorAttested: true }),
    });
    assert.equal(careWithoutRetention.status, 409);

    const retention = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/summary_retention`, {
      method: "POST", headers, body: JSON.stringify({ status: "granted", operatorAttested: true }),
    });
    assert.equal(retention.status, 201);
    const care = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/care_summary_sharing`, {
      method: "POST", headers, body: JSON.stringify({ status: "granted", operatorAttested: true }),
    });
    assert.equal(care.status, 201);
    assert.deepEqual(
      fixture.database.prepare("SELECT actor_type, action, target_type, metadata_json FROM audit_events WHERE person_id = ? ORDER BY occurred_at, rowid").all("person-a"),
      [
        { actor_type: "operator", action: "person.consent_attested", target_type: "person", metadata_json: '{"kind":"summary_retention","status":"granted"}' },
        { actor_type: "operator", action: "person.consent_attested", target_type: "person", metadata_json: '{"kind":"care_summary_sharing","status":"granted"}' },
      ],
    );

    const retentionWhileSharing = await fetch(`${fixture.url}/api/dashboard/people/person-a/consents/summary_retention`, {
      method: "POST", headers, body: JSON.stringify({ status: "revoked", operatorAttested: true }),
    });
    assert.equal(retentionWhileSharing.status, 409);
  } finally {
    fixture.close();
  }
});

test("limits enrollment drafting and opt-in invitations to operators", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.grantAccess({
      id: "grant-events", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_events"], tokenHash: hash("trusted-token"), expiresAt: futureExpiry(),
    });
    const trustedList = await fetch(`${fixture.url}/api/dashboard/people`, {
      headers: { Authorization: "Bearer trusted-token" },
    });
    assert.equal(trustedList.status, 403);

    const createdPerson = await fetch(`${fixture.url}/api/dashboard/people`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Morgan", phoneE164: "+15550004444" }),
    });
    assert.equal(createdPerson.status, 201);
    const person = (await createdPerson.json()) as { person: { id: string; displayName: string } };
    assert.equal(person.person.displayName, "Morgan");

    const duplicatePhone = await fetch(`${fixture.url}/api/dashboard/people`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Casey", phoneE164: "+15550004444" }),
    });
    assert.equal(duplicatePhone.status, 409);
    const duplicateBody = (await duplicatePhone.json()) as { error: string };
    assert.match(duplicateBody.error, /already used by an enrolled person/i);

    const badContact = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Lee", relationship: "friend", phoneE164: "5550005555" }),
    });
    assert.equal(badContact.status, 400);
    const badContactBody = (await badContact.json()) as { error: string };
    assert.match(badContactBody.error, /E\.164/i);

    const missingName = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: " ", relationship: "friend", phoneE164: "+15550005555" }),
    });
    assert.equal(missingName.status, 400);
    const missingNameBody = (await missingName.json()) as { error: string };
    assert.match(missingNameBody.error, /enter a name/i);

    const createdContact = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Lee", relationship: "friend", phoneE164: "+15550005555" }),
    });
    assert.equal(createdContact.status, 201);
    const firstContact = (await createdContact.json()) as { contact: { id: string }; smsOptInStatus: string };
    assert.equal(firstContact.smsOptInStatus, "not_opted_in");

    const correctedPhone = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts/${firstContact.contact.id}/phone`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phoneE164: "+15550006666" }),
    });
    assert.equal(correctedPhone.status, 200);
    assert.equal(fixture.repositories.getTrustedContact(firstContact.contact.id)?.phoneE164, "+15550006666");

    const removedContact = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts/${firstContact.contact.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(removedContact.status, 204);
    assert.equal(fixture.repositories.getTrustedContact(firstContact.contact.id), null);

    const recreatedContact = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Lee", relationship: "friend", phoneE164: "+15550005555" }),
    });
    assert.equal(recreatedContact.status, 201);
    const contact = (await recreatedContact.json()) as { contact: { id: string }; smsOptInStatus: string };

    const missingAttestation = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts/${contact.contact.id}/opt-in-invitations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operatorAttested: false }),
    });
    assert.equal(missingAttestation.status, 400);

    const invitation = await fetch(`${fixture.url}/api/dashboard/people/${person.person.id}/trusted-contacts/${contact.contact.id}/opt-in-invitations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operatorAttested: true }),
    });
    assert.equal(invitation.status, 201);
    const invitationBody = (await invitation.json()) as { optInLink: string; invitation: { expiresAt: string } };
    const link = new URL(invitationBody.optInLink);
    assert.equal(link.pathname, "/opt-in");
    assert.equal(link.searchParams.get("token")?.length, 43);
    assert.ok(new Date(invitationBody.invitation.expiresAt).getTime() > Date.now());
    const stored = fixture.database.prepare("SELECT token_hash, consumed_at FROM sms_opt_in_invitations").get() as { token_hash: string; consumed_at: string | null };
    assert.notEqual(stored.token_hash, link.searchParams.get("token"));
    assert.equal(stored.consumed_at, null);
    const audit = fixture.database.prepare("SELECT actor_type, action, metadata_json FROM audit_events WHERE target_id = ?").get(contact.contact.id) as { actor_type: string; action: string; metadata_json: string };
    assert.deepEqual(audit, { actor_type: "operator", action: "trusted_contact.sms_invite_authorized", metadata_json: "{}" });
  } finally {
    fixture.close();
  }
});

test("distinguishes an unconfigured operator number from a trusted-contact redaction", async () => {
  const fixture = await createDashboardServer();
  try {
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"), expiresAt: futureExpiry(),
    });
    const [operatorResponse, trustedResponse] = await Promise.all([
      fetch(`${fixture.url}/api/dashboard/people/person-b/overview`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
        headers: { Authorization: "Bearer summaries-token" },
      }),
    ]);
    const operatorBody = (await operatorResponse.json()) as { person: { phoneE164: string | null; phoneNumberStatus: string } };
    const trustedBody = (await trustedResponse.json()) as { person: { phoneE164: string | null; phoneNumberStatus: string } };
    assert.deepEqual(operatorBody.person, { id: "person-b", displayName: "Blair", phoneE164: null, phoneNumberStatus: "not_configured" });
    assert.deepEqual(trustedBody.person, { id: "person-a", displayName: "Avery", phoneE164: null, phoneNumberStatus: "private" });
  } finally { fixture.close(); }
});

test("projects dashboard data without SMS, provider, transcript, or audit fields", async () => {
  const fixture = await createDashboardServer();
  const secretSmsBody = "Private SMS body must never reach the dashboard";
  const secretPhone = "+15551234567";
  const secretProviderId = "SM-private-provider-id";
  const secretTranscript = "private raw transcript words";
  const secretNarrowRecap = "Private narrow recap";
  const secretFact = "private durable fact";
  const secretAnchor = "private recall anchor";
  const safeCareSummary = {
    recap: "Avery shared that the night felt difficult.",
    moodAndConcerns: ["Avery said they felt worried."],
    irisSuggestedNextSteps: ["Iris suggested taking a quiet break."],
  };

  try {
    fixture.repositories.recordConsent({ id: "retention", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
    fixture.repositories.recordConsent({ id: "care", personId: "person-a", kind: "care_summary_sharing", status: "granted", source: "test" });
    fixture.repositories.createCall({
      id: "call-private", personId: "person-a", providerCallId: "CA-private-provider-id", status: "completed",
    });
    fixture.repositories.completeCall({
      id: "call-private", status: "completed", summaryJson: JSON.stringify({
        recap: secretNarrowRecap,
        facts: [secretFact],
        people: [{ name: "Private person", relationshipOrContext: "private context" }],
        unresolvedTopics: ["private topic"],
        recallAnchor: secretAnchor,
        careSummary: safeCareSummary,
      }),
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
    fixture.repositories.createEvent({
      id: "event-shield-pause", personId: "person-a", type: "shield.pause_offered",
      payload: { situation: secretTranscript, redFlags: ["urgency"], risk: "high" },
    });
    fixture.repositories.createEvent({
      id: "event-shield-alert", personId: "person-a", type: "shield.alert_sent",
      payload: { contactName: "Robin", body: secretSmsBody, to: secretPhone, providerMessageId: secretProviderId },
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
    for (const value of [secretSmsBody, secretPhone, secretProviderId, secretTranscript, secretNarrowRecap, secretFact, secretAnchor, "Private person", "private context", "private topic", "CA-private-provider-id", "summaryJson"]) {
      assert.equal(serialized.includes(value), false);
    }
    assert.equal("providerCallId" in body.calls[0], false);
    assert.equal("summaryJson" in body.calls[0], false);
    assert.equal(body.calls[0].privateSummarySaved, true);
    assert.deepEqual(body.calls[0].careSummary, safeCareSummary);
    assert.equal("payload" in body.actions[0], false);
    assert.deepEqual(body.events.find((event) => event.type === "call.completed")?.payload, {});
    assert.deepEqual(body.events.find((event) => event.type === "bridge.sms_sent")?.payload, { contactName: "Robin" });
    assert.deepEqual(body.events.find((event) => event.type === "shield.pause_offered")?.payload, {});
    assert.deepEqual(body.events.find((event) => event.type === "shield.alert_sent")?.payload, { contactName: "Robin" });
  } finally {
    fixture.close();
  }
});

test("shares care recaps only while both consents are active and the link has view_summaries", async () => {
  const fixture = await createDashboardServer();
  const careSummary = {
    recap: "Avery had a difficult night.",
    moodAndConcerns: ["Avery said they had a nightmare."],
    irisSuggestedNextSteps: ["Iris suggested having breakfast."],
  };
  try {
    fixture.repositories.recordConsent({ id: "retention", personId: "person-a", kind: "summary_retention", status: "granted", source: "test" });
    fixture.repositories.recordConsent({ id: "care", personId: "person-a", kind: "care_summary_sharing", status: "granted", source: "test" });
    fixture.repositories.createCall({ id: "call-care", personId: "person-a", status: "completed" });
    fixture.repositories.completeCall({
      id: "call-care", status: "completed",
      summaryJson: JSON.stringify({ recap: "Private memory.", facts: ["Avery gardens."], people: [], unresolvedTopics: [], recallAnchor: "your garden", careSummary }),
    });
    fixture.repositories.grantAccess({
      id: "grant-summaries", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_summaries"], tokenHash: hash("summaries-token"), expiresAt: futureExpiry(),
    });
    fixture.repositories.grantAccess({
      id: "grant-events", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_events"], tokenHash: hash("events-token"), expiresAt: futureExpiry(),
    });
    const [adminResponse, trustedResponse, unscopedResponse] = await Promise.all([
      fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, { headers: { Authorization: `Bearer ${adminToken}` } }),
      fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, { headers: { Authorization: "Bearer summaries-token" } }),
      fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, { headers: { Authorization: "Bearer events-token" } }),
    ]);
    const admin = await adminResponse.json() as { calls: Array<Record<string, unknown>> };
    const trusted = await trustedResponse.json() as { calls: Array<Record<string, unknown>>; consents: unknown };
    const unscoped = await unscopedResponse.json() as { calls: unknown[] };
    assert.deepEqual(admin.calls[0]?.careSummary, careSummary);
    assert.equal(admin.calls[0]?.privateSummarySaved, true);
    assert.deepEqual(trusted.calls[0]?.careSummary, careSummary);
    assert.equal("privateSummarySaved" in trusted.calls[0]!, false);
    assert.equal(trusted.consents, null);
    assert.deepEqual(unscoped.calls, []);

    fixture.repositories.recordCareSummarySharingConsent({ id: "care-revoked", personId: "person-a", status: "revoked", source: "test" });
    const revoked = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, { headers: { Authorization: "Bearer summaries-token" } });
    const revokedBody = await revoked.json() as { calls: Array<{ careSummary: unknown }> };
    assert.equal(revokedBody.calls[0]?.careSummary, null);
    assert.equal(JSON.stringify(revokedBody).includes(careSummary.recap), false);
  } finally { fixture.close(); }
});

test("projects generic Shield safety events to trusted contacts with view_events only", async () => {
  const fixture = await createDashboardServer();
  const privateScenario = "A bank caller demanded gift cards and a passcode.";
  try {
    fixture.repositories.createEvent({ id: "shield-pause", personId: "person-a", type: "shield.pause_offered", payload: { situation: privateScenario, redFlags: ["urgency"] } });
    fixture.repositories.createEvent({ id: "shield-alert", personId: "person-a", type: "shield.alert_sent", payload: { contactName: "Robin", body: "private", to: "+15551234567" } });
    fixture.repositories.grantAccess({
      id: "grant-events", personId: "person-a", trustedContactId: "contact-a",
      scopes: ["view_events"], tokenHash: hash("events-token"), expiresAt: futureExpiry(),
    });
    const response = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: "Bearer events-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { events: Array<{ type: string; payload: unknown }> };
    assert.deepEqual(body.events.map((event) => ({ type: event.type, payload: event.payload })).sort((left, right) => left.type.localeCompare(right.type)), [
      { type: "shield.alert_sent", payload: { contactName: "Robin" } },
      { type: "shield.pause_offered", payload: {} },
    ]);
    assert.equal(JSON.stringify(body).includes(privateScenario), false);
    assert.equal(JSON.stringify(body).includes("+15551234567"), false);
  } finally { fixture.close(); }
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
    assert.equal((permittedBody.calls[0] as { careSummary?: unknown } | undefined)?.careSummary, null);
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
      grant: { id: string; createdAt: string; expiresAt: string };
      magicLink: string;
    };
    const accessToken = new URLSearchParams(
      new URL(body.magicLink).hash.replace(/^#/, ""),
    ).get("access");
    assert.ok(accessToken);
    assert.ok(body.grant.createdAt);
    assert.ok(new Date(body.grant.expiresAt).getTime() > Date.now());

    const overview = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(overview.status, 200);
    const overviewBody = (await overview.json()) as {
      contacts: Array<{ dashboardGrant: { id: string; expiresAt: string } | null }>;
    };
    assert.equal(overviewBody.contacts[0]?.dashboardGrant?.id, body.grant.id);
    assert.equal(overviewBody.contacts[0]?.dashboardGrant?.expiresAt, body.grant.expiresAt);

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

    const overviewAfter = await fetch(`${fixture.url}/api/dashboard/people/person-a/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const overviewAfterBody = (await overviewAfter.json()) as {
      contacts: Array<{ dashboardGrant: { id: string } | null }>;
    };
    assert.equal(overviewAfterBody.contacts[0]?.dashboardGrant, null);

    const missing = await fetch(
      `${fixture.url}/api/dashboard/access-grants/${body.grant.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(missing.status, 404);
  } finally {
    fixture.close();
  }
});
