import "dotenv/config";

import { loadFoundationConfig } from "../config.js";
import { closeDatabase, createDatabase, createRepositories, seedDemoFoundation } from "../db/index.js";

const config = loadFoundationConfig();
const database = createDatabase(config.databasePath);

try {
  seedDemoFoundation(createRepositories(database), config.demoPersonId);
  console.log(`Seeded demo foundation for ${config.demoPersonId}.`);
} finally {
  closeDatabase(database);
}
