import "dotenv/config";

import { createApp } from "./app.js";
import { loadDashboardConfig, loadFoundationConfig } from "./config.js";
import { closeDatabase, createDatabase, createRepositories } from "./db/index.js";

const port = Number(process.env.PORT ?? 3001);
const foundationConfig = loadFoundationConfig();
const dashboardConfig = loadDashboardConfig();
const database = createDatabase(foundationConfig.databasePath);
const app = createApp({
  dashboard: {
    repositories: createRepositories(database),
    adminToken: dashboardConfig.adminToken,
    frontendOrigin: dashboardConfig.frontendOrigin,
  },
});

const server = app.listen(port, () => {
  console.log(`Iris server listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => closeDatabase(database));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
