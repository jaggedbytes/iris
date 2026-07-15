import { useEffect, useRef } from "react";

import { useRealtimeVoice } from "./useRealtimeVoice";

export function App() {
  const {
    audioElement,
    activity,
    clearTranscript,
    error,
    isActive,
    isStarting,
    start,
    status,
    stop,
    transcript,
  } = useRealtimeVoice();

  const transcriptRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = transcriptRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [transcript]);

  const statusMessage = {
    idle: "Press Talk when you’re ready. Iris does not save this audio.",
    "requesting-microphone": "Asking for microphone access…",
    connecting: "Connecting you with Iris…",
    connected: "Iris is listening. Speak naturally when you’re ready.",
    error: error ?? "Iris could not start a voice session.",
  }[status];

  const activityMessage = {
    ready: "Ready",
    listening: "Listening",
    thinking: "Thinking",
    speaking: "Iris is speaking",
  }[activity];

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

        <aside className="evaluation-panel" aria-labelledby="notes-title">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Persona evaluation</p>
              <h2 id="notes-title">Conversation notes</h2>
            </div>
            <span className="activity-pill" aria-live="polite">
              {activityMessage}
            </span>
          </div>

          {transcript.length > 0 ? (
            <ol ref={transcriptRef} className="transcript-list" aria-live="polite">
              {transcript.map((entry) => (
                <li key={entry.id} className={`transcript-entry ${entry.speaker}`}>
                  <p className="speaker-label">
                    {entry.speaker === "you" ? "You" : "Iris"}
                    {!entry.isFinal && " · speaking…"}
                  </p>
                  <p>{entry.text || "…"}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-notes">
              Start a conversation to review the exchange here.
            </p>
          )}

          <div className="panel-footer">
            <p>Notes stay only in this browser tab and are not saved.</p>
            <button
              className="clear-button"
              type="button"
              disabled={transcript.length === 0}
              onClick={clearTranscript}
            >
              Clear notes
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}
