import { useRealtimeVoice } from "./useRealtimeVoice";

export function App() {
  const {
    audioElement,
    error,
    isActive,
    isStarting,
    start,
    status,
    stop,
  } = useRealtimeVoice();

  const statusMessage = {
    idle: "Press Talk when you’re ready. Iris does not save this audio.",
    "requesting-microphone": "Asking for microphone access…",
    connecting: "Connecting you with Iris…",
    connected: "Iris is listening. Speak naturally when you’re ready.",
    error: error ?? "Iris could not start a voice session.",
  }[status];

  return (
    <main className="voice-shell">
      <section className="voice-card" aria-labelledby="iris-title">
        <p className="eyebrow">Iris voice prototype</p>
        <h1 id="iris-title">A calm voice when it matters.</h1>
        <p className="intro">
          A private browser conversation to help us learn whether Iris feels
          warm, calm, and genuinely helpful.
        </p>

        <button
          className="talk-button"
          type="button"
          disabled={isStarting}
          onClick={isActive ? stop : start}
        >
          {isActive ? "End conversation" : isStarting ? "Connecting…" : "Talk to Iris"}
        </button>
        <p className={`status ${status === "error" ? "status-error" : ""}`} role="status">
          {statusMessage}
        </p>

        <audio ref={audioElement} controls className="remote-audio" />
      </section>
    </main>
  );
}
