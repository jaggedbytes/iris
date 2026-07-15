export function App() {
  return (
    <main className="voice-shell">
      <section className="voice-card" aria-labelledby="iris-title">
        <p className="eyebrow">Iris voice prototype</p>
        <h1 id="iris-title">A calm voice when it matters.</h1>
        <p className="intro">
          This first screen is the home for browser voice testing. The live
          WebRTC connection will be added in the next milestone.
        </p>

        <button className="talk-button" type="button" disabled>
          Talk to Iris
        </button>
        <p className="status" role="status">
          Voice connection not configured yet
        </p>
      </section>
    </main>
  );
}
