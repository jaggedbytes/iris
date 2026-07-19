import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { createApp } from "../src/app.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";
import { EnrollmentService } from "../src/enrollment.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const enrollmentConfig = {
  privacyUrl: "https://legal.example.test/privacy",
  termsUrl: "https://legal.example.test/terms",
  disclosureVersion: "2026-07-18",
  helpText: "Iris support: Reply STOP to opt out of Iris care texts.",
};

function fixture() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createTrustedContact({
    id: "contact-a", personId: "person-a", displayName: "Robin",
    relationship: "daughter", phoneE164: "+15550002222",
  });
  const token = "opaque-opt-in-token";
  repositories.createSmsOptInInvitation({
    id: "invite-a", personId: "person-a", trustedContactId: "contact-a",
    tokenHash: hash(token), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { database, repositories, token };
}

test("web opt-in atomically consumes the invitation, records consent, and dispatches one auto-approved confirmation", async () => {
  const { database, repositories, token } = fixture();
  const sent: string[] = [];
  const actions = new ActionDispatcher(
    repositories,
    {
      twilioAccountSid: "ACtest", twilioAuthToken: "test-token", twilioPhoneNumber: "+15550001111",
      publicBaseUrl: "https://iris.example.test",
    },
    { messages: { create: async (input) => {
      sent.push(input.body);
      return { sid: "SMconfirmation", status: "queued" };
    } } },
  );
  const service = new EnrollmentService(repositories, actions, enrollmentConfig);
  try {
    assert.deepEqual(service.validateInvitation(token), {
      personDisplayName: "Avery", contactDisplayName: "Robin",
      privacyUrl: enrollmentConfig.privacyUrl, termsUrl: enrollmentConfig.termsUrl,
      helpText: enrollmentConfig.helpText,
    });
    assert.deepEqual(service.acceptInvitation({ token, phoneE164: "+15550002222" }), { personDisplayName: "Avery" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "granted");
    const consent = repositories.listTrustedContactSmsConsents("contact-a")[0];
    assert.deepEqual(
      { phoneE164: consent?.phoneE164, source: consent?.source, disclosureVersion: consent?.disclosureVersion },
      { phoneE164: "+15550002222", source: "web_form", disclosureVersion: "2026-07-18" },
    );
    assert.equal(repositories.findActiveSmsOptInInvitation(hash(token)), null);
    const action = repositories.listActionRequests("person-a")[0];
    assert.equal(action?.feature, "enrollment");
    assert.equal(action?.actionType, "sms_confirmation");
    assert.equal(action?.approvalSource, "web_form");
    assert.equal(action?.status, "dispatched");
    assert.equal(repositories.getActionDispatch(action!.id)?.state, "dispatched");
    assert.deepEqual(sent, ["Iris: You’re subscribed to care check-in and Shield alert texts for Avery. Msg frequency varies. Msg & data rates may apply. Reply HELP for help. Reply STOP to opt out."]);
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM sms_opt_in_invitations").all()).includes(token), false);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM access_grants").get() as { count: number }).count, 0);
    assert.equal(service.acceptInvitation({ token, phoneE164: "+15550002222" }), null);
  } finally {
    closeDatabase(database);
  }
});

test("a mismatched phone, expired token, or missing acceptance leaves enrollment data unchanged", () => {
  const { database, repositories, token } = fixture();
  const service = new EnrollmentService(repositories, { dispatchSms: async () => null }, enrollmentConfig);
  try {
    assert.equal(service.acceptInvitation({ token, phoneE164: "+15550009999" }), null);
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), null);
    assert.ok(repositories.findActiveSmsOptInInvitation(hash(token)));
    assert.equal(repositories.listActionRequests("person-a").length, 0);
    assert.equal(service.validateInvitation("not-a-real-token"), null);
  } finally {
    closeDatabase(database);
  }
});

test("web opt-in commits a pending durable outbox entry before its background send", () => {
  const { database, repositories, token } = fixture();
  const service = new EnrollmentService(repositories, { dispatchSms: async () => null }, enrollmentConfig);
  try {
    assert.ok(service.acceptInvitation({ token, phoneE164: "+15550002222" }));
    const action = repositories.listActionRequests("person-a")[0];
    assert.equal(action?.status, "approved");
    assert.equal(action?.approvalSource, "web_form");
    assert.equal(repositories.getActionDispatch(action!.id)?.state, "pending");
    assert.deepEqual(repositories.getTrustedContactSmsEnrollmentState("contact-a"), {
      optInLinkState: "used",
      confirmationState: "queued",
    });
    repositories.createSmsOptInInvitation({
      id: "invite-newer-active", personId: "person-a", trustedContactId: "contact-a",
      tokenHash: "newer-active-token-hash", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(repositories.getTrustedContactSmsEnrollmentState("contact-a"), {
      optInLinkState: "active",
      confirmationState: "queued",
    });
    database.prepare("UPDATE action_dispatch_outbox SET state = 'needs_review' WHERE action_request_id = ?").run(action!.id);
    assert.deepEqual(repositories.getTrustedContactSmsEnrollmentState("contact-a"), {
      optInLinkState: "active",
      confirmationState: "needs_review",
    });
  } finally {
    closeDatabase(database);
  }
});

test("public opt-in endpoints never reflect the token or grant dashboard access", async () => {
  const { database, repositories, token } = fixture();
  const enrollment = new EnrollmentService(repositories, { dispatchSms: async () => null }, enrollmentConfig);
  const app = createApp({ enrollment });
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const validation = await fetch(`${url}/api/opt-in/validate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
    });
    assert.equal(validation.status, 200);
    const validationText = await validation.text();
    assert.equal(validationText.includes(token), false);
    assert.equal(validationText.includes("+15550002222"), false);

    const mismatch = await fetch(`${url}/api/opt-in/accept`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, phoneE164: "+15550009999", accepted: true }),
    });
    assert.equal(mismatch.status, 404);
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), null);

    const accepted = await fetch(`${url}/api/opt-in/accept`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, phoneE164: "+15550002222", accepted: true }),
    });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.text()).includes(token), false);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM access_grants").get() as { count: number }).count, 0);
  } finally {
    server.close();
    closeDatabase(database);
  }
});
