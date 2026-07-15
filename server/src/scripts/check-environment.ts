import "dotenv/config";

import { loadFoundationConfig } from "../config.js";

const config = loadFoundationConfig();
console.log(`Database configuration is valid: ${config.databasePath}`);
