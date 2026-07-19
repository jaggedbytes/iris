import assert from "node:assert/strict";
import test from "node:test";

import { ActionDispatcher } from "../src/actions.js";
import { BridgeService } from "../src/bridge.js";
import { closeDatabase, createDatabase, createRepositories } from "../src/db/index.js";
import { formatIrisSms, MAX_SMS_CONTENT_LENGTH, MAX_SMS_LENGTH, SMS_FOOTER, truncateSmsContent } from "../src/sms.js";

test("the SMS formatter owns one prefix and one HELP/STOP footer within the 480-character limit", () => {
  const standard = formatIrisSms("Please call me back.");
  assert.equal(standard, "Iris: Please call me back. Reply HELP for help. Reply STOP to opt out.");
  assert.equal(formatIrisSms(standard!), standard);
  assert.equal((standard!.match(/Iris:/g) ?? []).length, 1);
  assert.equal((standard!.match(/Reply HELP for help\. Reply STOP to opt out\./g) ?? []).length, 1);
  const truncated = truncateSmsContent("a".repeat(MAX_SMS_CONTENT_LENGTH + 50));
  const bounded = formatIrisSms(truncated);
  assert.equal(bounded?.length, MAX_SMS_LENGTH);
  assert.ok(bounded?.endsWith(SMS_FOOTER));
});

test("Bridge exposes and sends only contacts with a matching active SMS opt-in", async () => {
  const database = createDatabase(":memory:");
  const repositories = createRepositories(database);
  repositories.createPerson({ id: "person-a", displayName: "Avery" });
  repositories.createTrustedContact({ id: "contact-active", personId: "person-a", displayName: "Robin", relationship: "daughter", phoneE164: "+15550002222" });
  repositories.createTrustedContact({ id: "contact-revoked", personId: "person-a", displayName: "Sam", relationship: "son", phoneE164: "+15550003333" });
  repositories.createTrustedContact({ id: "contact-no-consent", personId: "person-a", displayName: "Lee", relationship: "friend", phoneE164: "+15550004444" });
  repositories.createTrustedContact({ id: "contact-changed", personId: "person-a", displayName: "Kai", relationship: "friend", phoneE164: "+15550005555" });
  repositories.recordTrustedContactSmsConsent({ id: "active", trustedContactId: "contact-active", phoneE164: "+15550002222", status: "granted", source: "web_form" });
  repositories.recordTrustedContactSmsConsent({ id: "revoked-granted", trustedContactId: "contact-revoked", phoneE164: "+15550003333", status: "granted", source: "web_form" });
  repositories.recordTrustedContactSmsConsent({ id: "revoked", trustedContactId: "contact-revoked", phoneE164: "+15550003333", status: "revoked", source: "inbound_stop" });
  repositories.recordTrustedContactSmsConsent({ id: "changed", trustedContactId: "contact-changed", phoneE164: "+15550006666", status: "granted", source: "web_form" });
  const sends: Array<{ to: string; body: string; messagingServiceSid: string }> = [];
  const dispatcher = new ActionDispatcher(repositories, {
    twilioAccountSid: "AC", twilioAuthToken: "token", twilioPhoneNumber: "+15550001111",
    twilioMessagingServiceSid: "MGservice", publicBaseUrl: "https://iris.test",
  }, { messages: { create: async (input) => {
    sends.push(input);
    return { sid: "SMeligible", status: "queued" };
  } } });
  const bridge = new BridgeService(repositories, dispatcher);
  try {
    assert.deepEqual(bridge.context("person-a").contacts.map((contact) => contact.id), ["contact-active"]);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-revoked", message: "Please call.", approvalId: "revoked" })).ok, false);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-no-consent", message: "Please call.", approvalId: "missing" })).ok, false);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-changed", message: "Please call.", approvalId: "changed" })).ok, false);
    assert.equal((await bridge.sendApprovedSms({ personId: "person-a", trustedContactId: "contact-active", message: "a".repeat(MAX_SMS_CONTENT_LENGTH + 10), approvalId: "active" })).ok, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.messagingServiceSid, "MGservice");
    assert.equal(sends[0]?.body.length, MAX_SMS_LENGTH);
  } finally {
    closeDatabase(database);
  }
});
