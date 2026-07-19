import assert from "node:assert/strict";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { createApp } from "../src/app.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";

function fixture() {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createPerson({ id: "person-b", displayName: "Blair" });
  repositories.createTrustedContact({ id: "contact-a", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-b", personId: "person-b", displayName: "Sam", relationship: "friend", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-c", personId: "person-a", displayName: "Lee", relationship: "friend", phoneE164: "+15550003333" });
  for (const [id, phone] of [["contact-a", "+15550002222"], ["contact-b", "+15550002222"], ["contact-c", "+15550003333"]] as const) {
    repositories.recordTrustedContactSmsConsent({ id: `granted-${id}`, trustedContactId: id, phoneE164: phone, status: "granted", source: "web_form" });
  }
  const actions = new ActionDispatcher(repositories, {
    twilioAccountSid: "AC", twilioAuthToken: "auth", twilioPhoneNumber: "+15550001111", publicBaseUrl: "https://iris.test",
  });
  return { database, repositories, actions };
}

test("a signed STOP webhook revokes every matching contact without persisting inbound content", async () => {
  const { database, repositories, actions } = fixture();
  actions.validateWebhook = () => true;
  const app = createApp({ actions, repositories });
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/messages/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "signed" },
      body: new URLSearchParams({ From: "+15550002222", OptOutType: "STOP", Body: "private stop request" }),
    });
    assert.equal(response.status, 200);
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "revoked");
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-b"), "revoked");
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-c"), "granted");
    assert.equal(repositories.isTrustedContactSmsEligible("contact-a"), false);
    const priorRevocations = repositories.listTrustedContactSmsConsents("contact-a").length;
    const standardStop = await fetch(`http://127.0.0.1:${address.port}/api/messages/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "signed" },
      body: new URLSearchParams({ From: "+15550002222", Body: "STOPALL" }),
    });
    assert.equal(standardStop.status, 200);
    assert.equal(repositories.listTrustedContactSmsConsents("contact-a").length, priorRevocations + 1);
    assert.equal(repositories.listEvents("person-a").length, 0);
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM messages").all()).includes("private stop request"), false);
  } finally {
    server.close();
    closeDatabase(database);
  }
});

test("unsigned inbound messages are rejected; HELP and START never alter local consent", async () => {
  const { database, repositories, actions } = fixture();
  let valid = false;
  actions.validateWebhook = () => valid;
  const app = createApp({ actions, repositories });
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/messages/inbound`;
  try {
    const blocked = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+15550002222", Body: "STOP" }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "granted");

    valid = true;
    for (const body of ["HELP", "START"]) {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "signed" },
        body: new URLSearchParams({ From: "+15550002222", Body: body }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(repositories.getTrustedContactSmsOptInStatus("contact-a"), "granted");
  } finally {
    server.close();
    closeDatabase(database);
  }
});
