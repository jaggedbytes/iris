import "dotenv/config";

import { loadFoundationConfig } from "../config.js";
import { closeDatabase, createDatabase, createRepositories } from "../db/index.js";

const config = loadFoundationConfig();
const database = createDatabase(config.databasePath);

try {
  createRepositories(database).resetAll();
  console.log("Cleared all Iris demo data.");
} finally {
  closeDatabase(database);
}
