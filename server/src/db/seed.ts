import type { IrisRepositories } from "./repositories.js";

export function seedDemoFoundation(repositories: IrisRepositories, personId: string) {
  repositories.resetAll();

  repositories.createPerson({
    id: personId,
    displayName: "Bean Jackson",
    phoneE164: "+12487228194",
  });
  repositories.createTrustedContact({
    id: "contact-evelyn",
    personId,
    displayName: "Evelyn Carter",
    phoneE164: "+15555550101",
    relationship: "neighbor",
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
