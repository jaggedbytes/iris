import { useCallback, useEffect, useRef, useState } from "react";

type VoiceStatus =
  | "idle"
  | "requesting-microphone"
  | "connecting"
  | "connected"
  | "error";

type RealtimeToken = {
  value: string;
};

export type TranscriptEntry = {
  id: string;
  speaker: "iris" | "you";
  text: string;
  isFinal: boolean;
};

type ConversationActivity = "ready" | "listening" | "thinking" | "speaking";

type RealtimeEvent = {
  type?: string;
  error?: { message?: string };
  item_id?: string;
  transcript?: string;
  delta?: string;
};

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

function messageForError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was not allowed. Please allow it and try again.";
  }

  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found. Connect one and try again.";
  }

  return "Iris could not start a voice session. Please try again.";
}

export function useRealtimeVoice() {
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ConversationActivity>("ready");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const updateTranscript = useCallback(
    (
      id: string,
      speaker: TranscriptEntry["speaker"],
      text: string,
      isFinal: boolean,
      append = false,
    ) => {
      setTranscript((entries) => {
        const existing = entries.find((entry) => entry.id === id);
        const nextText = append && existing ? `${existing.text}${text}` : text;

        if (existing) {
          return entries.map((entry) =>
            entry.id === id ? { ...entry, text: nextText, isFinal } : entry,
          );
        }

        return [...entries, { id, speaker, text: nextText, isFinal }];
      });
    },
    [],
  );

  const releaseResources = useCallback(() => {
    dataChannel.current?.close();
    dataChannel.current = null;

    peerConnection.current?.close();
    peerConnection.current = null;

    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;

    if (audioElement.current) {
      audioElement.current.srcObject = null;
    }
  }, []);

  const stop = useCallback(() => {
    releaseResources();
    setActivity("ready");
    setStatus("idle");
  }, [releaseResources]);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
  }, []);

  const start = useCallback(async () => {
    if (status !== "idle" && status !== "error") return;

    // An API event can put the hook in an error state while a peer connection
    // is still alive. Release it before a retry opens a new microphone stream.
    releaseResources();
    setError(null);
    setTranscript([]);
    setActivity("ready");
    setStatus("requesting-microphone");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Automatic gain can amplify a nearly silent room enough for VAD to
          // interpret it as speech. Preserve the microphone's natural level.
          autoGainControl: false,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      microphone.current = stream;

      setStatus("connecting");
      const tokenResponse = await fetch(`${apiBaseUrl}/api/realtime/token`);
      if (!tokenResponse.ok) {
        throw new Error("The Iris server could not create a voice session.");
      }

      const token = (await tokenResponse.json()) as RealtimeToken;
      if (!token.value) {
        throw new Error("The Iris server returned an invalid voice session.");
      }

      const connection = new RTCPeerConnection();
      peerConnection.current = connection;

      connection.ontrack = ({ streams }) => {
        const [remoteStream] = streams;
        if (!audioElement.current || !remoteStream) return;

        audioElement.current.srcObject = remoteStream;
        void audioElement.current.play().catch(() => {
          // Autoplay may be blocked by a browser; the visible controls provide
          // an accessible fallback without disrupting the session.
        });
      };

      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "connected") {
          setStatus("connected");
          setActivity("listening");
        }

        if (connection.connectionState === "failed") {
          setError("The voice connection ended unexpectedly.");
          releaseResources();
          setStatus("error");
        }
      };

      stream.getTracks().forEach((track) => connection.addTrack(track, stream));

      const events = connection.createDataChannel("oai-events");
      dataChannel.current = events;
      events.addEventListener("message", ({ data }) => {
        let event: RealtimeEvent;

        try {
          event = JSON.parse(data) as RealtimeEvent;
        } catch {
          return;
        }

        if (event.type === "error") {
          setError(event.error?.message ?? "Iris encountered a voice error.");
          releaseResources();
          setActivity("ready");
          setStatus("error");
          return;
        }

        if (event.type === "input_audio_buffer.speech_started") {
          setActivity("listening");
          return;
        }

        if (event.type === "input_audio_buffer.speech_stopped") {
          setActivity("thinking");
          return;
        }

        if (
          event.type ===
            "conversation.item.input_audio_transcription.completed" &&
          event.item_id &&
          event.transcript
        ) {
          updateTranscript(event.item_id, "you", event.transcript, true);
          setActivity("thinking");
          return;
        }

        if (
          event.type === "response.output_audio_transcript.delta" &&
          event.item_id &&
          event.delta
        ) {
          updateTranscript(event.item_id, "iris", event.delta, false, true);
          setActivity("speaking");
          return;
        }

        if (
          event.type === "response.output_audio_transcript.done" &&
          event.item_id
        ) {
          updateTranscript(event.item_id, "iris", event.transcript ?? "", true);
          setActivity("speaking");
          return;
        }

        if (event.type === "response.done") {
          setActivity("listening");
        }
      });

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      const response = await fetch(REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!response.ok) {
        throw new Error("OpenAI could not establish the voice connection.");
      }

      await connection.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });
    } catch (startError) {
      // Stop tracks and close partial connections before allowing a retry.
      releaseResources();

      setError(messageForError(startError));
      setActivity("ready");
      setStatus("error");
    }
  }, [releaseResources, status, updateTranscript]);

  useEffect(() => releaseResources, [releaseResources]);

  return {
    audioElement,
    activity,
    clearTranscript,
    error,
    isActive: status === "connected" || status === "connecting",
    isStarting: status === "requesting-microphone" || status === "connecting",
    start,
    status,
    stop,
    transcript,
  };
}
