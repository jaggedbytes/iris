import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import helmet from "helmet";

import { createDashboardRouter, type DashboardContext } from "./dashboard.js";
import { createTelephonyRouter } from "./telephony/router.js";
import type { OutboundCallManager } from "./telephony/outbound.js";
import type { ActionDispatcher } from "./actions.js";
import { createEnrollmentRouter, type EnrollmentService } from "./enrollment.js";
import { createInboundMessagingRouter } from "./inbound-messaging.js";
import type { IrisRepositories } from "./db/repositories.js";

const compiledStaticDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public",
);

function isProtectedPath(path: string) {
  return path === "/api" || path.startsWith("/api/") || path === "/health";
}

export function createApp({
  dashboard,
  telephony,
  actions,
  enrollment,
  repositories,
  staticDir = compiledStaticDir,
}: {
  dashboard?: DashboardContext;
  telephony?: OutboundCallManager;
  actions?: ActionDispatcher;
  enrollment?: EnrollmentService;
  repositories?: IrisRepositories;
  staticDir?: string;
} = {}) {
  const app = express();

  app.use(helmet());

  app.use(
    cors({
      origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    }),
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  if (dashboard) {
    app.use("/api/dashboard", createDashboardRouter(dashboard));
  }
  if (telephony) app.use("/api/telephony", createTelephonyRouter(telephony));
  if (enrollment) app.use("/api/opt-in", createEnrollmentRouter(enrollment));
  const sharedRepositories = repositories ?? dashboard?.repositories;
  if (actions && sharedRepositories) app.use(
    "/api/messages",
    createInboundMessagingRouter({ repositories: sharedRepositories, actions }),
  );
  if (actions) app.post("/api/actions/:actionId/messages/status", (request, response) => {
    if (!actions.validateWebhook(request.header("x-twilio-signature"), request.originalUrl, request.body)) return response.status(403).end();
    if (typeof request.body?.MessageSid === "string" && typeof request.body?.MessageStatus === "string") actions.recordDelivery(request.params.actionId, request.body.MessageSid, request.body.MessageStatus);
    response.status(204).end();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // The hosted image copies the Vite build to this directory. Local Vite
  // development has no such directory, so this remains entirely opt-in there.
  const indexHtml = resolve(staticDir, "index.html");
  if (existsSync(indexHtml)) {
    const serveStatic = express.static(staticDir);
    app.use((request, response, next) => {
      if (isProtectedPath(request.path)) return next();
      return serveStatic(request, response, next);
    });
    // SPA routes such as /opt-in must resolve to the dashboard build, but only
    // after all API/webhook routes have had a chance to handle the request.
    app.use((request, response, next) => {
      if (request.method !== "GET" || isProtectedPath(request.path)) return next();
      response.sendFile(indexHtml);
    });
  }

  return app;
}
