import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { createRealtimeClientSecret } from "./realtime.js";

export function createApp({ request = fetch }: { request?: typeof fetch } = {}) {
  const app = express();

  app.use(helmet());

  app.use(
    cors({
      origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    }),
  );

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

export const app = createApp();
