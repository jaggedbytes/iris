import "dotenv/config";
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { loadDashboardConfig, loadFoundationConfig, loadTelephonyConfig } from "./config.js";
import { closeDatabase, createDatabase, createRepositories } from "./db/index.js";
import { OutboundCallManager } from "./telephony/outbound.js";
import { attachMediaServer } from "./telephony/router.js";
import { CallSummaryPipeline } from "./summary.js";

const port = Number(process.env.PORT ?? 3001);
const foundationConfig = loadFoundationConfig();
const dashboardConfig = loadDashboardConfig();
const telephonyConfig = loadTelephonyConfig();
const database = createDatabase(foundationConfig.databasePath);
const repositories = createRepositories(database);
const summaries = new CallSummaryPipeline(repositories, telephonyConfig.openaiApiKey, telephonyConfig.safetyIdentifier);
const telephony = new OutboundCallManager(repositories, telephonyConfig, undefined, undefined, summaries);
const app = createApp({
  dashboard: {
    repositories,
    adminToken: dashboardConfig.adminToken,
    frontendOrigin: dashboardConfig.frontendOrigin,
    startOutboundCall: (personId) => telephony.startCall(personId),
  },
  telephony,
});

const server = createServer(app);
attachMediaServer(server, telephony);
server.listen(port, () => {
  console.log(`Iris server listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => closeDatabase(database));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
