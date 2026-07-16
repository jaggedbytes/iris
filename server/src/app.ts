import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { createDashboardRouter, type DashboardContext } from "./dashboard.js";
import { createRealtimeClientSecret } from "./realtime.js";
import { createTelephonyRouter } from "./telephony/router.js";
import type { OutboundCallManager } from "./telephony/outbound.js";
import type { ActionDispatcher } from "./actions.js";

export function createApp({
  request = fetch,
  dashboard,
  telephony,
  actions,
}: {
  request?: typeof fetch;
  dashboard?: DashboardContext;
  telephony?: OutboundCallManager;
  actions?: ActionDispatcher;
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
  if (actions) app.post("/api/actions/messages/status", (request, response) => {
    if (!actions.validateWebhook(request.header("x-twilio-signature"), request.originalUrl, request.body)) return response.status(403).end();
    if (typeof request.body?.MessageSid === "string" && typeof request.body?.MessageStatus === "string") actions.recordDelivery(request.body.MessageSid, request.body.MessageStatus);
    response.status(204).end();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // The token route mints billable Realtime credentials. This prototype has no
  // accounts by design (a hardcoded senior + family pair), so rate limiting is
  // the scope-appropriate guard against a direct caller draining the API budget.
  const tokenLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many voice session requests. Please slow down." },
  });

  app.get("/api/realtime/token", tokenLimiter, async (_request, response) => {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      response.status(500).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }

    try {
      const clientSecret = await createRealtimeClientSecret({ apiKey, request });

      // Client secrets are credentials: do not allow browsers or intermediaries
      // to cache this response.
      response.set("Cache-Control", "no-store").json(clientSecret);
    } catch (error) {
      console.error("Unable to create Realtime client secret", error);
      response.status(502).json({ error: "Unable to start a voice session." });
    }
  });

  return app;
}
