import type { Server } from "node:http";

import { Router } from "express";
import { WebSocketServer } from "ws";

import type { OutboundCallManager } from "./outbound.js";

export function createTelephonyRouter(manager: OutboundCallManager) {
  const router = Router();
  router.post("/twiml/outbound/:callId", (request, response) => {
    if (!manager.validateWebhook(request.header("x-twilio-signature"), request.originalUrl, request.body)) {
      return response.status(403).type("text/plain").send("Invalid Twilio signature.");
    }
    const twiml = manager.twiml(request.params.callId);
    if (!twiml) return response.status(404).type("text/plain").send("Call session not found.");
    response.type("text/xml").send(twiml);
  });
  router.post("/status/:callId", (request, response) => {
    if (!manager.validateWebhook(request.header("x-twilio-signature"), request.originalUrl, request.body)) {
      return response.status(403).end();
    }
    if (typeof request.body?.CallStatus === "string") manager.handleStatus(request.params.callId, request.body.CallStatus);
    response.status(204).end();
  });
  return router;
}

export function attachMediaServer(server: Server, manager: OutboundCallManager) {
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/telephony/media") return socket.destroy();
    websocketServer.handleUpgrade(request, socket, head, (websocket) => manager.acceptMediaSocket(websocket));
  });
  return websocketServer;
}
