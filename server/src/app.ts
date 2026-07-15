import cors from "cors";
import express from "express";

export const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  }),
);

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

// Next milestone: GET /api/realtime/token.
// This trusted server route will create a short-lived Realtime client secret.
// It must never return OPENAI_API_KEY to the browser.
