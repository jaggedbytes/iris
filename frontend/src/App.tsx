import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  dashboardJson,
  DashboardError,
} from "./dashboard";
import type { DashboardOverview, DashboardPrincipal } from "./dashboard";

const SESSION_TOKEN_KEY = "iris-dashboard-access-token";
const DASHBOARD_POLL_INTERVAL_MS = 2_500;

function readMagicLinkToken() {
  const fragment = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(fragment);
  const token = params.get("access");
  if (!token) return null;

  params.delete("access");
  const location = new URL(window.location.href);
  const remaining = params.toString();
  location.hash = remaining ? `#${remaining}` : "";
  window.history.replaceState({}, "", location);
  return token;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function summaryLabel(summaryJson: string | null, summaryState: DashboardOverview["calls"][number]["summaryState"]) {
  if (summaryState === "processing") return "Preparing call summary…";
  if (!summaryJson) return "No saved summary yet";
  try {
    const summary = JSON.parse(summaryJson) as { recap?: string };
    return summary.recap ?? "Saved call summary";
  } catch {
    return "Saved call summary";
  }
}

function timelineCopy(event: DashboardOverview["events"][number], personName: string) {
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as { requesterDisplayName?: unknown; contactName?: unknown; status?: unknown }
    : {};
  const requester = typeof payload.requesterDisplayName === "string" ? payload.requesterDisplayName : "Family";
  const contact = typeof payload.contactName === "string" ? payload.contactName : "a trusted contact";
  const deliveryStatus = typeof payload.status === "string" ? payload.status : "updated";

  switch (event.type) {
    case "check_in.requested": return `${requester} requested an Iris check-in`;
    case "call.attempted": return `Iris started calling ${personName}`;
    case "call.answered": return `${personName} answered Iris’s call`;
    case "call.stream_started": return "Iris began listening";
    case "call.completed": return "Call ended";
    case "call.failed": return "Call could not be completed";
    case "call.interrupted": return "Call was interrupted";
    case "call.summary_ready": return "Call summary is ready";
    case "call.summary_unavailable": return "No call summary was saved";
    case "bridge.sms_sent": return `Iris sent a Bridge message to ${contact}`;
    case "action.dispatched": return "Message accepted by the SMS provider";
    case "action.reconciled": return "Message delivery was reconciled";
    case "sms.delivery_updated": return `Message delivery ${deliveryStatus}`;
    case "action.dispatch_needs_review": return "A message send needs operator review";
    case "action.failed": return "A message could not be sent";
    default: return "Iris activity updated";
  }
}

function actionCopy(action: DashboardOverview["actions"][number]) {
  if (action.dispatchState === "needs_review") {
    return "Delivery is uncertain. Confirm with the recipient or Twilio before retrying.";
  }
  if (action.dispatchState === "retryable") return "This send can be retried manually.";
  if (action.dispatchState === "dispatching") return "Waiting for delivery confirmation.";
  if (action.dispatchState === "failed" || action.status === "failed") return "This message was not sent.";
  if (action.dispatchState === "dispatched") return "Message sent.";
  return action.status === "pending_approval" ? "Waiting for approval." : action.status;
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
  const [isCallRequesting, setIsCallRequesting] = useState(false);
  const [dispatchingActionId, setDispatchingActionId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const magicLinkRequestId = useRef(0);
  const overviewRequestId = useRef(0);

  const personId = useMemo(() => {
    if (overview) return overview.person.id;
    if (principal) return principal.personId;
    return "";
  }, [overview, principal]);

  useEffect(() => {
    if (!token) {
      overviewRequestId.current += 1;
      setPrincipal(null);
      setOverview(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = ++overviewRequestId.current;
    if (!overview) setIsLoading(true);

    void (async () => {
      try {
        const nextPrincipal = await dashboardJson<DashboardPrincipal>("/api/dashboard/me", token);
        const nextPersonId = nextPrincipal.personId;
        const nextOverview = await dashboardJson<DashboardOverview>(
          `/api/dashboard/people/${nextPersonId}/overview`,
          token,
        );
        if (cancelled || requestId !== overviewRequestId.current) return;
        setPrincipal(nextPrincipal);
        setOverview(nextOverview);
        setError(null);
      } catch (loadError) {
        if (cancelled || requestId !== overviewRequestId.current) return;
        if (loadError instanceof DashboardError && loadError.isAuthError) {
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
          setToken("");
        }
        setError(loadError instanceof Error ? loadError.message : "Unable to load the dashboard.");
      } finally {
        if (!cancelled && requestId === overviewRequestId.current) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, refreshVersion]);

  const shouldPoll = Boolean(
    overview?.activeCall || overview?.calls.some((call) => call.summaryState === "processing"),
  );

  useEffect(() => {
    if (!token || !shouldPoll) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setRefreshVersion((current) => current + 1);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, DASHBOARD_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [token, shouldPoll]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = adminTokenInput.trim();
    if (!nextToken) return;
    sessionStorage.setItem(SESSION_TOKEN_KEY, nextToken);
    setToken(nextToken);
  };

  const signOut = () => {
    magicLinkRequestId.current += 1;
    overviewRequestId.current += 1;
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken("");
    setMagicLink(null);
  };

  const createMagicLink = async (trustedContactId: string) => {
    const requestId = ++magicLinkRequestId.current;
    setMagicLink(null);
    setError(null);
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
      if (requestId === magicLinkRequestId.current) setMagicLink(result.magicLink);
    } catch (linkError) {
      if (requestId === magicLinkRequestId.current) {
        setError(linkError instanceof Error ? linkError.message : "Unable to create a link.");
      }
    }
  };

  const startCall = async () => {
    if (!personId) return;
    setIsCallRequesting(true);
    setError(null);
    try {
      await dashboardJson(`/api/dashboard/people/${personId}/calls`, token, {
        method: "POST",
      });
      setRefreshVersion((current) => current + 1);
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : "Iris could not place the call.");
    } finally {
      setIsCallRequesting(false);
    }
  };

  const retrySms = async (actionId: string) => {
    setDispatchingActionId(actionId);
    setError(null);
    try {
      await dashboardJson(`/api/dashboard/actions/${actionId}/dispatch`, token, { method: "POST" });
      setRefreshVersion((current) => current + 1);
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : "Iris could not retry the message.");
    } finally {
      setDispatchingActionId(null);
    }
  };

  const activeCall = overview?.activeCall ?? null;
  const callStateLabel = activeCall?.status === "answered"
    ? "Call in progress"
    : activeCall
      ? "Calling…"
      : "Call now";
  const callDisabled = !overview || isCallRequesting || Boolean(activeCall);
  const canRequestCheckIn = principal?.role === "trusted_contact"
    && principal.scopes.includes("request_check_in");

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
          {principal?.role === "admin" && (
            <button className="call-button" type="button" disabled={callDisabled} onClick={() => void startCall()}>
              {callStateLabel}
            </button>
          )}
          {canRequestCheckIn && (
            <button className="call-button" type="button" disabled={callDisabled} onClick={() => void startCall()}>
              {activeCall ? callStateLabel : "Ask Iris to check in"}
            </button>
          )}
          <button className="text-button" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {error && <p className="form-error" role="alert">{error}</p>}
      {isLoading && <p className="loading-note">Loading the current picture…</p>}
      {activeCall && (
        <p className="call-status" aria-live="polite">
          {activeCall.status === "answered" ? "Iris is on a call now." : "Iris is calling now."}
        </p>
      )}

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
                    <strong>{summaryLabel(call.summaryJson, call.summaryState)}</strong>
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
                    <strong>{timelineCopy(event, overview.person.displayName)}</strong>
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
                    <span>{actionCopy(action)}</span>
                    {action.dispatchState === "needs_review" && (
                      <>
                        <span className="warning-note">Retrying may create a duplicate message.</span>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={dispatchingActionId === action.id}
                          onClick={() => void retrySms(action.id)}
                        >
                          {dispatchingActionId === action.id ? "Retrying…" : "Retry SMS"}
                        </button>
                      </>
                    )}
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
