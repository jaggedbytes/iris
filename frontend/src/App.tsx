import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import {
  dashboardJson,
} from "./dashboard";
import type { DashboardOverview, DashboardPrincipal } from "./dashboard";

const SESSION_TOKEN_KEY = "iris-dashboard-access-token";

function readMagicLinkToken() {
  const location = new URL(window.location.href);
  const token = location.searchParams.get("access");
  if (!token) return null;

  location.searchParams.delete("access");
  window.history.replaceState({}, "", location);
  return token;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function summaryLabel(summaryJson: string | null) {
  if (!summaryJson) return "No saved summary yet";
  try {
    const summary = JSON.parse(summaryJson) as { recap?: string };
    return summary.recap ?? "Saved call summary";
  } catch {
    return "Saved call summary";
  }
}

export function App() {
  const [token, setToken] = useState(() => {
    const magicLinkToken = readMagicLinkToken();
    if (magicLinkToken) {
      sessionStorage.setItem(SESSION_TOKEN_KEY, magicLinkToken);
      return magicLinkToken;
    }
    return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? "";
  });
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [principal, setPrincipal] = useState<DashboardPrincipal | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(token));
  const [magicLink, setMagicLink] = useState<string | null>(null);

  const personId = useMemo(() => {
    if (overview) return overview.person.id;
    if (principal?.role === "trusted_contact") return principal.personId;
    return "person-demo";
  }, [overview, principal]);

  useEffect(() => {
    if (!token) {
      setPrincipal(null);
      setOverview(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const nextPrincipal = await dashboardJson<DashboardPrincipal>("/api/dashboard/me", token);
        const nextPersonId =
          nextPrincipal.role === "trusted_contact"
            ? nextPrincipal.personId
            : "person-demo";
        const nextOverview = await dashboardJson<DashboardOverview>(
          `/api/dashboard/people/${nextPersonId}/overview`,
          token,
        );
        if (cancelled) return;
        setPrincipal(nextPrincipal);
        setOverview(nextOverview);
      } catch (loadError) {
        if (cancelled) return;
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        setToken("");
        setError(loadError instanceof Error ? loadError.message : "Unable to load the dashboard.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = adminTokenInput.trim();
    if (!nextToken) return;
    sessionStorage.setItem(SESSION_TOKEN_KEY, nextToken);
    setToken(nextToken);
  };

  const signOut = () => {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken("");
    setMagicLink(null);
  };

  const createMagicLink = async (trustedContactId: string) => {
    try {
      const result = await dashboardJson<{ magicLink: string }>(
        `/api/dashboard/people/${personId}/magic-links`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trustedContactId,
            scopes: ["view_summaries", "view_events", "request_check_in"],
          }),
        },
      );
      setMagicLink(result.magicLink);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "Unable to create a link.");
    }
  };

  if (!token && !isLoading) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="access-title">
          <p className="eyebrow">Iris companion</p>
          <h1 id="access-title">Trusted dashboard access.</h1>
          <p>
            Family links are scoped and revocable. Operators can sign in with
            the local dashboard token.
          </p>
          <form onSubmit={signIn}>
            <label htmlFor="admin-token">Operator access token</label>
            <input
              id="admin-token"
              type="password"
              value={adminTokenInput}
              onChange={(event) => setAdminTokenInput(event.target.value)}
              autoComplete="current-password"
            />
            <button type="submit">Open dashboard</button>
          </form>
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Iris companion</p>
          <h1>{overview?.person.displayName ?? "Loading Iris…"}</h1>
          <p className="header-subtitle">
            {principal?.role === "admin"
              ? "Operator view"
              : `Trusted view for ${principal?.trustedContact?.displayName ?? "family"}`}
          </p>
        </div>
        <div className="header-actions">
          <button className="call-button" type="button" disabled title="Available in the outbound phone checkpoint">
            Call now
          </button>
          <button className="text-button" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {error && <p className="form-error" role="alert">{error}</p>}
      {isLoading && <p className="loading-note">Loading the current picture…</p>}

      {overview && (
        <div className="dashboard-grid">
          <section className="overview-card profile-card">
            <p className="card-kicker">Person</p>
            <h2>{overview.person.displayName}</h2>
            <p>{overview.person.phoneE164 ?? "Phone number not configured"}</p>
            <p className="privacy-note">Only consented summaries are retained. Call audio and raw transcripts are not saved.</p>
          </section>

          <section className="overview-card">
            <div className="card-heading">
              <div>
                <p className="card-kicker">Recent calls</p>
                <h2>Conversation continuity</h2>
              </div>
              <span className="count-pill">{overview.calls.length}</span>
            </div>
            {overview.calls.length ? (
              <ol className="item-list">
                {overview.calls.map((call) => (
                  <li key={call.id}>
                    <strong>{summaryLabel(call.summaryJson)}</strong>
                    <span>{formatDate(call.startedAt)} · {call.status}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-state">Calls will appear here after the phone foundation is connected.</p>
            )}
          </section>

          <section className="overview-card">
            <div className="card-heading">
              <div>
                <p className="card-kicker">Timeline</p>
                <h2>What’s happened</h2>
              </div>
              <span className="count-pill">{overview.events.length}</span>
            </div>
            {overview.events.length ? (
              <ol className="item-list">
                {overview.events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.type.replaceAll(".", " · ")}</strong>
                    <span>{formatDate(event.occurredAt)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-state">Bridge, Shield, and Translator events will appear here.</p>
            )}
          </section>

          <section className="overview-card">
            <p className="card-kicker">Trusted contacts</p>
            <h2>People in the circle</h2>
            {overview.contacts.length ? (
              <ul className="contact-list">
                {overview.contacts.map((contact) => (
                  <li key={contact.id}>
                    <div>
                      <strong>{contact.displayName}</strong>
                      <span>{contact.relationship}</span>
                    </div>
                    {principal?.role === "admin" && (
                      <button className="secondary-button" type="button" onClick={() => void createMagicLink(contact.id)}>
                        Create link
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">Contact access is not available through this link.</p>
            )}
            {magicLink && (
              <div className="magic-link" aria-live="polite">
                <strong>New family link</strong>
                <input readOnly value={magicLink} aria-label="New trusted contact link" />
                <span>Share this once; it expires in seven days and can be revoked.</span>
              </div>
            )}
          </section>

          <section className="overview-card actions-card">
            <p className="card-kicker">Actions</p>
            <h2>Approval queue</h2>
            {overview.actions.length ? (
              <ol className="item-list">
                {overview.actions.map((action) => (
                  <li key={action.id}>
                    <strong>{action.feature} · {action.actionType}</strong>
                    <span>{action.status}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-state">Approved actions will appear here before anything is sent.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
