import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { irisV1 } from "../personas/iris-v1.js";

export type SocketLike = EventEmitter & {
  send(data: string): void;
  close(): void;
  readyState?: number;
};

export type RealtimeSocketFactory = (input: {
  apiKey: string;
  safetyIdentifier: string;
}) => SocketLike;
export type LiveTranscriptTurn = { speaker: "user" | "assistant"; text: string };

export const createRealtimeSocket: RealtimeSocketFactory = ({
  apiKey,
  safetyIdentifier,
}) =>
  new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
  });

type TwilioStart = {
  streamSid: string;
  customParameters?: Record<string, string>;
};

type RealtimeEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { code?: string; message?: string };
  name?: string; call_id?: string; arguments?: string;
};

/**
 * Owns one live phone conversation. Its transcript buffer is intentionally
 * private and is cleared on every close; no raw text ever crosses this class's
 * process boundary or reaches SQLite.
 */
export class CallSession {
  private streamSid: string | null = null;
  private realtime: SocketLike | null = null;
  private realtimeReady = false;
  private bufferedAudio: string[] = [];
  private liveTranscript: LiveTranscriptTurn[] = [];
  private closed = false;
  private readonly debugRealtime = process.env.IRIS_REALTIME_DEBUG === "true";

  constructor(
    readonly callId: string,
    private readonly streamToken: string,
    private readonly twilioSocket: SocketLike,
    private readonly realtimeFactory: RealtimeSocketFactory,
    private readonly realtimeCredentials: {
      apiKey: string;
      safetyIdentifier: string;
    },
    private readonly onClose: (reason: "completed" | "failed", transcript: LiveTranscriptTurn[]) => void,
    private readonly bridge?: { context: string; dispatch: (contactId: string, message: string, approvalId: string) => Promise<{ ok: boolean; contactName?: string }> },
  ) {
    twilioSocket.on("message", (data: Buffer | string) => this.handleTwilioMessage(data));
    twilioSocket.on("close", () => this.close("completed"));
    twilioSocket.on("error", () => this.close("failed"));
  }

  private handleTwilioMessage(data: Buffer | string) {
    let message: { event?: string; start?: TwilioStart; media?: { payload?: string } };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      this.close("failed");
      return;
    }

    if (message.event === "start" && message.start) {
      this.start(message.start);
    } else if (message.event === "media" && message.media?.payload) {
      this.forwardInput(message.media.payload);
    } else if (message.event === "stop") {
      this.close("completed");
    }
  }

  private start(start: TwilioStart) {
    if (this.closed || this.realtime) return;
    if (start.customParameters?.callId !== this.callId || start.customParameters.streamToken !== this.streamToken) {
      this.close("failed");
      return;
    }
    this.streamSid = start.streamSid;
    this.realtime = this.realtimeFactory(this.realtimeCredentials);
    this.realtime.on("open", () => {
      if (!this.realtime || this.closed) return;
      try {
        this.realtime.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: irisV1,
              ...(this.bridge ? { instructions: `${irisV1}\n\nBridge memory context (do not mention this list unless helpful):\n${this.bridge.context}\n\nYou may only call bridge_send_sms after the person clearly says yes to sending a specific message to a listed trusted contact. First say who you would contact and what you would send, then ask for approval. Never call it on ambiguity.` } : {}),
              output_modalities: ["audio"],
              tools: this.bridge ? [{ type: "function", name: "bridge_send_sms", description: "Send an explicitly approved SMS to a listed trusted contact.", parameters: { type: "object", additionalProperties: false, required: ["trusted_contact_id", "message"], properties: { trusted_contact_id: { type: "string" }, message: { type: "string", maxLength: 480 } } } }] : [],
              audio: {
                input: {
                  // Twilio Media Streams use G.711 μ-law, named PCMU by the
                  // Realtime API. Keeping both ends in PCMU avoids transcoding.
                  format: { type: "audio/pcmu" },
                  transcription: { model: "gpt-4o-transcribe" },
                  turn_detection: { type: "server_vad" },
                },
                output: { format: { type: "audio/pcmu" }, voice: "marin" },
              },
            },
          }),
        );
        this.debug("session.update sent");
      } catch {
        this.close("failed");
        return;
      }
    });
    this.realtime.on("message", (data: Buffer | string) => this.handleRealtimeMessage(data));
    this.realtime.on("error", (error: Error) => {
      this.debug(`socket error: ${error.message}`);
      this.close("failed");
    });
    // An unsolicited upstream close is a mid-call failure. Intentional shutdowns
    // set `closed` before closing this socket, so close() no-ops for those.
    this.realtime.on("close", () => this.close("failed"));
  }

  private forwardInput(payload: string) {
    if (this.closed) return;
    if (!this.realtime || !this.realtimeReady) {
      // A short bounded queue handles the small gap between Twilio's start and
      // the Realtime socket opening without turning audio into durable storage.
      if (this.bufferedAudio.length < 100) this.bufferedAudio.push(payload);
      return;
    }
    this.appendAudio(payload);
  }

  private appendAudio(payload: string) {
    if (!this.realtime || !this.realtimeReady || this.closed) return;
    try {
      this.realtime.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
    } catch {
      this.close("failed");
    }
  }

  private handleRealtimeMessage(data: Buffer | string) {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(data.toString()) as typeof event;
    } catch {
      this.close("failed");
      return;
    }
    this.logRealtimeEvent(event);
    if (event.type === "error") {
      this.close("failed");
      return;
    }
    if (event.type === "session.updated") {
      this.realtimeReady = true;
      for (const audio of this.bufferedAudio.splice(0)) this.appendAudio(audio);
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.name === "bridge_send_sms" && event.call_id && event.arguments && this.bridge) {
      void this.handleBridgeTool(event.call_id, event.arguments);
      return;
    }
    if (event.type === "response.output_audio.delta" && event.delta && this.streamSid) {
      this.twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: event.delta },
      }));
    }
    if (event.type === "input_audio_buffer.speech_started" && this.streamSid) {
      this.twilioSocket.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      this.liveTranscript.push({ speaker: "user", text: event.transcript });
    }
    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      this.liveTranscript.push({ speaker: "assistant", text: event.transcript });
    }
  }

  private logRealtimeEvent(event: RealtimeEvent) {
    if (!this.debugRealtime) return;
    if (event.type === "response.output_audio.delta" && event.delta) {
      this.debug(`response.output_audio.delta (${Buffer.from(event.delta, "base64").byteLength} bytes)`);
      return;
    }
    if (event.type === "error") {
      this.debug(`error${event.error?.code ? ` (${event.error.code})` : ""}: ${event.error?.message ?? "unknown error"}`);
      return;
    }
    this.debug(`received ${event.type ?? "event without a type"}`);
  }

  private debug(message: string) {
    if (this.debugRealtime) console.info(`[Iris Realtime ${this.callId}] ${message}`);
  }

  private async handleBridgeTool(callId: string, argumentsJson: string) {
    let args: { trusted_contact_id?: unknown; message?: unknown };
    try { args = JSON.parse(argumentsJson) as typeof args; } catch { return; }
    const result = typeof args.trusted_contact_id === "string" && typeof args.message === "string"
      ? await this.bridge!.dispatch(args.trusted_contact_id, args.message, callId).catch(() => ({ ok: false }))
      : { ok: false };
    this.realtime?.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } }));
    this.realtime?.send(JSON.stringify({ type: "response.create" }));
  }

  close(reason: "completed" | "failed") {
    if (this.closed) return;
    this.closed = true;
    this.bufferedAudio.length = 0;
    const transcript = this.liveTranscript.splice(0);
    this.realtimeReady = false;
    this.realtime?.close();
    this.realtime = null;
    // On a fallback finalization, the provider socket may still be open even
    // though it failed to deliver its own close event.
    this.twilioSocket.close();
    this.onClose(reason, transcript);
  }
}
