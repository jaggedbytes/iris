import { randomBytes, randomUUID } from "node:crypto";

import twilio from "twilio";

import type { TelephonyConfig } from "../config.js";
import type { IrisRepositories } from "../db/repositories.js";
import { CallSession, createRealtimeSocket, type RealtimeSocketFactory, type SocketLike } from "./call-session.js";
import type { TranscriptTurn } from "../summary.js";
import type { BridgeService } from "../bridge.js";

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

type ActiveCall = {
  personId: string;
  streamToken: string;
  session?: CallSession;
  terminalStatus?: "completed" | "failed";
  finalizationTimer?: unknown;
};

export const DEFAULT_STREAM_CLOSE_GRACE_MS = 10_000;
export const DEFAULT_MEDIA_HANDSHAKE_TIMEOUT_MS = 10_000;
export type CallSummaryProcessor = { process(input: { callId: string; personId: string; transcript: TranscriptTurn[] }): Promise<void> };
export type CallScheduler = {
  setTimeout(callback: () => void, delayMs: number): { unref?: () => void };
  clearTimeout(handle: unknown): void;
};
const systemScheduler: CallScheduler = { setTimeout, clearTimeout };

export class OutboundCallManager {
  private readonly activeCalls = new Map<string, ActiveCall>();

  constructor(
    private readonly repositories: IrisRepositories,
    private readonly config: TelephonyConfig,
    private readonly client: TwilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken),
    private readonly realtimeFactory: RealtimeSocketFactory = createRealtimeSocket,
    private readonly summaries?: CallSummaryProcessor,
    private readonly scheduler: CallScheduler = systemScheduler,
    private readonly streamCloseGraceMs = DEFAULT_STREAM_CLOSE_GRACE_MS,
    private readonly bridge?: BridgeService,
    private readonly handshakeTimeoutMs = DEFAULT_MEDIA_HANDSHAKE_TIMEOUT_MS,
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
      const terminalStatus = callStatus === "completed" ? "completed" : "failed";
      // A terminal callback can precede the final WebSocket close and its last
      // transcription events. Let an established session close itself first.
      if (active.session) {
        active.terminalStatus = terminalStatus;
        if (!active.finalizationTimer) {
          active.finalizationTimer = this.scheduler.setTimeout(() => {
            active.session?.close(terminalStatus);
          }, this.streamCloseGraceMs);
          (active.finalizationTimer as { unref?: () => void }).unref?.();
        }
        return;
      }
      this.finish(callId, terminalStatus, terminalStatus === "completed" ? "call.completed" : "call.failed");
    }
  }

  acceptMediaSocket(socket: SocketLike) {
    // The public media endpoint must not retain unauthenticated sockets. Close
    // any connection that has not sent a valid `start` within the deadline.
    let handshakeTimer: unknown = this.scheduler.setTimeout(() => {
      handshakeTimer = null;
      socket.close();
    }, this.handshakeTimeoutMs);
    (handshakeTimer as { unref?: () => void }).unref?.();
    const clearHandshakeTimer = () => {
      if (handshakeTimer === null) return;
      this.scheduler.clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };
    socket.on("close", clearHandshakeTimer);
    socket.on("error", clearHandshakeTimer);

    const awaitStart = (raw: Buffer | string) => {
      let message: { event?: string; start?: { customParameters?: { callId?: string; streamToken?: string } } };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { clearHandshakeTimer(); socket.close(); return; }
      // Twilio sends `connected` before the `start` message that contains our
      // custom parameters. It is informational, not an authentication failure.
      if (message.event === "connected") return;
      const callId = message.start?.customParameters?.callId;
      const streamToken = message.start?.customParameters?.streamToken;
      const active = callId ? this.activeCalls.get(callId) : undefined;
      // Authenticate (and reject a duplicate session) before touching the active
      // call, so an unauthenticated socket can never finalize a legitimate call.
      if (
        message.event !== "start" ||
        !callId ||
        !active ||
        active.session ||
        !streamToken ||
        streamToken !== active.streamToken
      ) { clearHandshakeTimer(); socket.close(); return; }
      socket.off("message", awaitStart);
      clearHandshakeTimer();
      active.session = new CallSession(
        callId,
        active.streamToken,
        socket,
        this.realtimeFactory,
        { apiKey: this.config.openaiApiKey, safetyIdentifier: this.config.safetyIdentifier },
        (streamStatus, transcript) => {
          const status = active.terminalStatus ?? streamStatus;
          this.finish(callId, status, status === "completed" ? "call.completed" : "call.failed", transcript);
        },
        this.bridge ? {
          context: JSON.stringify(this.bridge.context(active.personId)),
          dispatch: (contactId, message, approvalId) => this.bridge!.sendApprovedSms({ personId: active.personId, trustedContactId: contactId, message, approvalId }),
        } : undefined,
      );
      socket.emit("message", raw);
      this.repositories.createEvent({ id: randomUUID(), personId: active.personId, callId, type: "call.stream_started", payload: { transport: "twilio_media_stream" } });
    };
    socket.on("message", awaitStart);
  }

  private finish(callId: string, status: "completed" | "failed", eventType: string, transcript: TranscriptTurn[] = []) {
    const active = this.activeCalls.get(callId);
    if (!active) return;
    this.activeCalls.delete(callId);
    if (active.finalizationTimer) this.scheduler.clearTimeout(active.finalizationTimer);
    const shouldProcessSummary = status === "completed" && transcript.length > 0 && this.repositories.hasActiveConsent(active.personId, "summary_retention");
    // Set processing before detaching the background promise. This leaves no
    // observable post-hangup window where an eligible call looks unsummarized.
    this.repositories.completeCall({
      id: callId,
      status,
      summaryState: shouldProcessSummary ? "processing" : status === "failed" ? "unavailable" : "not_requested",
    });
    this.repositories.createEvent({ id: randomUUID(), personId: active.personId, callId, type: eventType, payload: { transport: "twilio" } });
    if (shouldProcessSummary && this.summaries) {
      // Summary processing runs after finalization; a rejection must never
      // surface as an unhandled rejection. Observe it without call context that
      // could carry transcript content.
      try {
        void this.summaries.process({ callId, personId: active.personId, transcript })
          .catch((error) => {
            this.repositories.updateCallSummaryState({ id: callId, summaryState: "unavailable" });
            console.error("Call summary processing failed", { callId, error: error instanceof Error ? error.message : "unknown error" });
          });
      } catch (error) {
        this.repositories.updateCallSummaryState({ id: callId, summaryState: "unavailable" });
        console.error("Call summary processing failed", { callId, error: error instanceof Error ? error.message : "unknown error" });
      }
    } else if (shouldProcessSummary) {
      // A consented call with a final transcript must not look permanently
      // unsummarized if the processor was not configured.
      this.repositories.updateCallSummaryState({ id: callId, summaryState: "unavailable" });
    }
  }
}
