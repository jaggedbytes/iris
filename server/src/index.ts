import "dotenv/config";
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { loadDashboardConfig, loadEnrollmentConfig, loadFoundationConfig, loadTelephonyConfig } from "./config.js";
import { closeDatabase, createDatabase, createRepositories } from "./db/index.js";
import { OutboundCallManager } from "./telephony/outbound.js";
import { attachMediaServer } from "./telephony/router.js";
import { CallSummaryPipeline } from "./summary.js";
import { ActionDispatcher } from "./actions.js";
import { BridgeService } from "./bridge.js";
import { ShieldService } from "./shield.js";
import { EnrollmentService } from "./enrollment.js";

const port = Number(process.env.PORT ?? 3001);
const foundationConfig = loadFoundationConfig();
const dashboardConfig = loadDashboardConfig();
const telephonyConfig = loadTelephonyConfig();
const enrollmentConfig = loadEnrollmentConfig();
const database = createDatabase(foundationConfig.databasePath);
const repositories = createRepositories(database);
const summaries = new CallSummaryPipeline(repositories, telephonyConfig.openaiApiKey, telephonyConfig.safetyIdentifier);
const actions = new ActionDispatcher(repositories, telephonyConfig);
const enrollment = new EnrollmentService(repositories, actions, enrollmentConfig);
const bridge = new BridgeService(repositories, actions);
const shield = new ShieldService(repositories, telephonyConfig.openaiApiKey, telephonyConfig.safetyIdentifier, undefined, actions);
const telephony = new OutboundCallManager(repositories, telephonyConfig, undefined, undefined, summaries, undefined, undefined, bridge, undefined, undefined, undefined, shield);
const app = createApp({
  dashboard: {
    repositories,
    adminToken: dashboardConfig.adminToken,
    frontendOrigin: dashboardConfig.frontendOrigin,
    demoPersonId: foundationConfig.demoPersonId,
    startOutboundCall: ({ personId, checkInRequester }) => telephony.startCall(personId, checkInRequester),
    actions,
  },
  telephony,
  actions,
  enrollment,
});

const server = createServer(app);
attachMediaServer(server, telephony);

async function start() {
  await telephony.recoverInterruptedCalls();
  server.listen(port, () => {
    console.log(`Iris server listening on http://localhost:${port}`);
  });
}

void start().catch((error) => {
  console.error("Iris server startup failed", error instanceof Error ? error.message : "unknown error");
  closeDatabase(database);
  process.exitCode = 1;
});

// Periodically park stale uncertain SMS claims for manual review (never auto-send).
const dispatchSweep = setInterval(() => {
  try {
    actions.recoverStaleDispatches();
  } catch (error) {
    console.error("Stale dispatch recovery failed", error instanceof Error ? error.message : "unknown error");
  }
}, 60_000);
dispatchSweep.unref();

function shutdown() {
  clearInterval(dispatchSweep);
  server.close(() => closeDatabase(database));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
