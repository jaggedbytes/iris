import "dotenv/config";

import { loadFoundationConfig } from "../config.js";
import { closeDatabase, createDatabase, createRepositories, seedDemoFoundation } from "../db/index.js";

const config = loadFoundationConfig();
const database = createDatabase(config.databasePath);

const demoPhoneE164 = process.env.IRIS_DEMO_PHONE_E164?.trim() || null;

try {
  seedDemoFoundation(createRepositories(database), config.demoPersonId, demoPhoneE164);
  console.log(
    `Seeded demo foundation for ${config.demoPersonId}${demoPhoneE164 ? ` with demo destination ${demoPhoneE164}` : " with no callable number"}.`,
  );
} finally {
  closeDatabase(database);
}
