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

type RealtimeEvent = {
  type?: string;
  error?: { message?: string };
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
    setStatus("idle");
  }, [releaseResources]);

  const start = useCallback(async () => {
    if (status !== "idle" && status !== "error") return;

    // An API event can put the hook in an error state while a peer connection
    // is still alive. Release it before a retry opens a new microphone stream.
    releaseResources();
    setError(null);
    setStatus("requesting-microphone");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
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
          setStatus("error");
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
      setStatus("error");
    }
  }, [releaseResources, status]);

  useEffect(() => releaseResources, [releaseResources]);

  return {
    audioElement,
    error,
    isActive: status === "connected" || status === "connecting",
    isStarting: status === "requesting-microphone" || status === "connecting",
    start,
    status,
    stop,
  };
}
