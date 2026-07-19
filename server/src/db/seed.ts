import type { IrisRepositories } from "./repositories.js";

export function seedDemoFoundation(
  repositories: IrisRepositories,
  personId: string,
  demoPhoneE164: string | null = null,
) {
  repositories.resetAll();

  repositories.createPerson({
    id: personId,
    displayName: "Bean Jackson",
    // Never seed a routable number: with live Twilio credentials the dashboard
    // could place a real call. Populate only from an explicit demo destination.
    phoneE164: demoPhoneE164,
  });
  repositories.createTrustedContact({
    id: "contact-evelyn",
    personId,
    displayName: "Evelyn Carter",
    phoneE164: "+15555550101",
    relationship: "neighbor",
  });
  // This non-routable fixture is explicitly opted in so automated demo flows
  // exercise the same eligibility gate as a real web-form enrollment.
  repositories.recordTrustedContactSmsConsent({
    id: "consent-evelyn-sms-demo",
    trustedContactId: "contact-evelyn",
    phoneE164: "+15555550101",
    status: "granted",
    source: "demo_seed",
    disclosureVersion: "demo-seed",
  });
  repositories.recordConsent({
    id: "consent-summary-retention",
    personId,
    kind: "summary_retention",
    status: "granted",
    source: "demo-seed",
  });
  repositories.createEvent({
    id: "event-demo-seeded",
    personId,
    type: "demo.seeded",
    payload: { version: 1 },
  });
}
