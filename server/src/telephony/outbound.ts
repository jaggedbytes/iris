import { randomBytes, randomUUID } from "node:crypto";

import twilio from "twilio";

import type { TelephonyConfig } from "../config.js";
import type { IrisRepositories } from "../db/repositories.js";
import { CallSession, createRealtimeSocket, type RealtimeSocketFactory, type SocketLike } from "./call-session.js";

type TwilioClient = {
  calls: {
    create(input: {
      to: string;
      from: string;
      url: string;
      method: "POST";
      statusCallback: string;
      statusCallbackMethod: "POST";
      statusCallbackEvent: string[];
    }): Promise<{ sid: string }>;
  };
};

type ActiveCall = { personId: string; streamToken: string; session?: CallSession };

export class OutboundCallManager {
  private readonly activeCalls = new Map<string, ActiveCall>();

  constructor(
    private readonly repositories: IrisRepositories,
    private readonly config: TelephonyConfig,
    private readonly client: TwilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken),
    private readonly realtimeFactory: RealtimeSocketFactory = createRealtimeSocket,
  ) {}

  async startCall(personId: string) {
    const person = this.repositories.getPerson(personId);
    if (!person?.phoneE164) throw new Error("The person does not have a phone number.");
    const callId = randomUUID();
    const streamToken = randomBytes(32).toString("base64url");
    this.repositories.createCall({ id: callId, personId, status: "attempted" });
    this.repositories.createEvent({ id: randomUUID(), personId, callId, type: "call.attempted", payload: { transport: "twilio" } });
    this.activeCalls.set(callId, { personId, streamToken });

    try {
      const call = await this.client.calls.create({
        to: person.phoneE164,
        from: this.config.twilioPhoneNumber,
        url: `${this.config.publicBaseUrl}/api/telephony/twiml/outbound/${callId}`,
        method: "POST",
        statusCallback: `${this.config.publicBaseUrl}/api/telephony/status/${callId}`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      this.repositories.updateCall({ id: callId, providerCallId: call.sid });
      return { callId };
    } catch (error) {
      this.finish(callId, "failed", "call.failed");
      throw error;
    }
  }

  twiml(callId: string) {
    const active = this.activeCalls.get(callId);
    if (!active) return null;
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({ url: this.config.publicBaseUrl.replace(/^https:/, "wss:") + "/api/telephony/media" });
    stream.parameter({ name: "callId", value: callId });
    stream.parameter({ name: "streamToken", value: active.streamToken });
    return response.toString();
  }

  validateWebhook(signature: string | undefined, path: string, body: Record<string, unknown>) {
    if (!signature) return false;
    return twilio.validateRequest(
      this.config.twilioAuthToken,
      signature,
      `${this.config.publicBaseUrl}${path}`,
      body,
    );
  }

  handleStatus(callId: string, callStatus: string) {
    const active = this.activeCalls.get(callId);
    if (!active) return;
    // Twilio's `answered` StatusCallbackEvent arrives with CallStatus set to
    // `in-progress`; `answered` itself is not a CallStatus value.
    if (callStatus === "in-progress") {
      this.repositories.updateCall({ id: callId, status: "answered" });
      this.repositories.createEvent({ id: randomUUID(), personId: active.personId, callId, type: "call.answered", payload: { transport: "twilio" } });
    }
    if (["completed", "busy", "no-answer", "canceled", "failed"].includes(callStatus)) {
      this.finish(callId, callStatus === "completed" ? "completed" : "failed", callStatus === "completed" ? "call.completed" : "call.failed");
    }
  }

  acceptMediaSocket(socket: SocketLike) {
    const awaitStart = (raw: Buffer | string) => {
      let message: { event?: string; start?: { customParameters?: { callId?: string } } };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { socket.close(); return; }
      // Twilio sends `connected` before the `start` message that contains our
      // custom parameters. It is informational, not an authentication failure.
      if (message.event === "connected") return;
      const callId = message.start?.customParameters?.callId;
      const active = callId && this.activeCalls.get(callId);
      if (message.event !== "start" || !active) { socket.close(); return; }
      socket.off("message", awaitStart);
      active.session = new CallSession(
        callId,
        active.streamToken,
        socket,
        this.realtimeFactory,
        { apiKey: this.config.openaiApiKey, safetyIdentifier: this.config.safetyIdentifier },
        (status) => this.finish(callId, status, status === "completed" ? "call.completed" : "call.failed"),
      );
      socket.emit("message", raw);
      this.repositories.createEvent({ id: randomUUID(), personId: active.personId, callId, type: "call.stream_started", payload: { transport: "twilio_media_stream" } });
    };
    socket.on("message", awaitStart);
  }

  private finish(callId: string, status: "completed" | "failed", eventType: string) {
    const active = this.activeCalls.get(callId);
    if (!active) return;
    this.activeCalls.delete(callId);
    // A provider completion callback can arrive slightly before the WebSocket
    // close. Closing the in-memory session here guarantees its audio queue and
    // transient transcript buffer do not outlive the call.
    active.session?.close(status);
    this.repositories.completeCall({ id: callId, status });
    this.repositories.createEvent({ id: randomUUID(), personId: active.personId, callId, type: eventType, payload: { transport: "twilio" } });
  }
}
