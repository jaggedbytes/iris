import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  dashboardJson,
  DashboardError,
} from "./dashboard";
import type { DashboardOverview, DashboardPersonList, DashboardPrincipal } from "./dashboard";

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

function summaryLabel(summaryRecap: string | null, summaryState: DashboardOverview["calls"][number]["summaryState"]) {
  if (summaryState === "processing") return "Preparing call summary…";
  if (summaryState === "unavailable") return "Call summary unavailable";
  if (summaryRecap) return summaryRecap;
  if (summaryState === "ready") return "Saved call summary";
  // not_requested: hangups with no transcript never enter extraction.
  return "No conversation to summarize";
}

function phoneNumberLabel(person: DashboardOverview["person"]) {
  if (person.phoneNumberStatus === "private") return "Phone number is private in this view.";
  if (person.phoneNumberStatus === "not_configured") return "Phone number not configured";
  return person.phoneE164 ?? "Phone number unavailable";
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
    case "shield.pause_offered": return "Iris offered a safety pause";
    case "shield.alert_sent": return `Iris asked ${contact} to check in`;
    case "action.dispatched": return "Message accepted by the SMS provider";
    case "action.reconciled": return "Message delivery was reconciled";
    case "sms.delivery_updated": return `Message delivery ${deliveryStatus}`;
    case "action.dispatch_needs_review": return "A message send needs operator review";
    case "action.failed": return "A message could not be sent";
    default: return "Iris activity updated";
  }
}

function actionLabel(action: DashboardOverview["actions"][number]) {
  if (action.feature === "shield" && action.actionType === "sms") return "Shield check-in alert";
  if (action.feature === "bridge" && action.actionType === "sms") return "Bridge message";
  return `${action.feature} · ${action.actionType}`;
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
  const [optInLink, setOptInLink] = useState<string | null>(null);
  const [adminPeople, setAdminPeople] = useState<DashboardPersonList>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonPhone, setNewPersonPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactRelationship, setContactRelationship] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [isCreatingPerson, setIsCreatingPerson] = useState(false);
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [attestedContactIds, setAttestedContactIds] = useState<Record<string, boolean>>({});
  const [isCallRequesting, setIsCallRequesting] = useState(false);
  const [dispatchingActionId, setDispatchingActionId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const magicLinkRequestId = useRef(0);
  const overviewRequestId = useRef(0);
  // Skip interval/visibility refreshes while an overview load is still running so
  // a slow response is not cancelled every 2.5s into an endless backlog.
  const overviewLoadInFlight = useRef(false);

  const personId = useMemo(() => {
    if (overview) return overview.person.id;
    if (principal) return principal.personId;
    return "";
  }, [overview, principal]);

  useEffect(() => {
    if (!token) {
      overviewRequestId.current += 1;
      overviewLoadInFlight.current = false;
      setPrincipal(null);
      setOverview(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = ++overviewRequestId.current;
    overviewLoadInFlight.current = true;
    if (!overview) setIsLoading(true);

    void (async () => {
      try {
        const nextPrincipal = await dashboardJson<DashboardPrincipal>("/api/dashboard/me", token);
        const nextPersonId = nextPrincipal.role === "admin"
          ? selectedPersonId ?? nextPrincipal.personId
          : nextPrincipal.personId;
        const people = nextPrincipal.role === "admin"
          ? await dashboardJson<{ people: DashboardPersonList }>("/api/dashboard/people", token)
          : null;
        const nextOverview = await dashboardJson<DashboardOverview>(
          `/api/dashboard/people/${nextPersonId}/overview`,
          token,
        );
        if (cancelled || requestId !== overviewRequestId.current) return;
        setPrincipal(nextPrincipal);
        setOverview(nextOverview);
        if (people) setAdminPeople(people.people);
        setError(null);
      } catch (loadError) {
        if (cancelled || requestId !== overviewRequestId.current) return;
        if (loadError instanceof DashboardError && loadError.isAuthError) {
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
          setToken("");
        }
        setError(loadError instanceof Error ? loadError.message : "Unable to load the dashboard.");
      } finally {
        if (!cancelled && requestId === overviewRequestId.current) {
          overviewLoadInFlight.current = false;
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, refreshVersion, selectedPersonId]);

  const shouldPoll = Boolean(
    overview?.activeCall || overview?.calls.some((call) => call.summaryState === "processing"),
  );

  useEffect(() => {
    if (!token || !shouldPoll) return;
    const refreshWhenVisible = () => {
      if (
        document.visibilityState === "visible"
        && !overviewLoadInFlight.current
      ) {
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
    setOptInLink(null);
    setSelectedPersonId(null);
    setAdminPeople([]);
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

  const createPerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreatingPerson(true);
    setError(null);
    try {
      const result = await dashboardJson<{ person: { id: string } }>("/api/dashboard/people", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: newPersonName, phoneE164: newPersonPhone || null }),
      });
      setNewPersonName("");
      setNewPersonPhone("");
      setSelectedPersonId(result.person.id);
      setRefreshVersion((current) => current + 1);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the person.");
    } finally {
      setIsCreatingPerson(false);
    }
  };

  const createTrustedContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId) return;
    setIsCreatingContact(true);
    setError(null);
    try {
      await dashboardJson(`/api/dashboard/people/${personId}/trusted-contacts`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: contactName,
          relationship: contactRelationship,
          phoneE164: contactPhone,
        }),
      });
      setContactName("");
      setContactRelationship("");
      setContactPhone("");
      setRefreshVersion((current) => current + 1);
    } catch (contactError) {
      setError(contactError instanceof Error ? contactError.message : "Unable to draft the trusted contact.");
    } finally {
      setIsCreatingContact(false);
    }
  };

  const createOptInLink = async (trustedContactId: string) => {
    if (!personId) return;
    setOptInLink(null);
    setError(null);
    try {
      const result = await dashboardJson<{ optInLink: string }>(
        `/api/dashboard/people/${personId}/trusted-contacts/${trustedContactId}/opt-in-invitations`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operatorAttested: attestedContactIds[trustedContactId] === true }),
        },
      );
      setOptInLink(result.optInLink);
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Unable to create an opt-in link.");
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
          {principal?.role === "admin" && (
            <section className="overview-card enrollment-card">
              <p className="card-kicker">Enrollment</p>
              <h2>People and invitations</h2>
              <label htmlFor="person-select">Person</label>
              <select
                id="person-select"
                value={personId}
                onChange={(event) => {
                  setSelectedPersonId(event.target.value);
                  setOptInLink(null);
                  setMagicLink(null);
                }}
              >
                {adminPeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
              </select>
              <form className="compact-form" onSubmit={createPerson}>
                <strong>Add a person</strong>
                <input required placeholder="Display name" value={newPersonName} onChange={(event) => setNewPersonName(event.target.value)} />
                <input placeholder="Phone in E.164 (optional)" value={newPersonPhone} onChange={(event) => setNewPersonPhone(event.target.value)} />
                <button className="secondary-button" type="submit" disabled={isCreatingPerson}>
                  {isCreatingPerson ? "Adding…" : "Add person"}
                </button>
              </form>
            </section>
          )}
          <section className="overview-card profile-card">
            <p className="card-kicker">Person</p>
            <h2>{overview.person.displayName}</h2>
            <p>{phoneNumberLabel(overview.person)}</p>
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
                    <strong>{summaryLabel(call.summaryRecap, call.summaryState)}</strong>
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
                      <span>{contact.relationship} · SMS: {contact.smsOptInStatus === "opted_in" ? "opted in" : contact.smsOptInStatus === "opted_out" ? "opted out" : "not opted in"}</span>
                    </div>
                    {principal?.role === "admin" && (
                      <div className="contact-actions">
                        <button className="secondary-button" type="button" onClick={() => void createMagicLink(contact.id)}>Create dashboard link</button>
                        <label className="attestation-check">
                          <input
                            type="checkbox"
                            checked={attestedContactIds[contact.id] === true}
                            onChange={(event) => setAttestedContactIds((current) => ({ ...current, [contact.id]: event.target.checked }))}
                          />
                          I’m authorized to invite this contact
                        </label>
                        <button className="secondary-button" type="button" disabled={!attestedContactIds[contact.id]} onClick={() => void createOptInLink(contact.id)}>Create SMS opt-in link</button>
                      </div>
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
            {optInLink && (
              <div className="magic-link" aria-live="polite">
                <strong>SMS opt-in link</strong>
                <input readOnly value={optInLink} aria-label="Trusted contact SMS opt-in link" />
                <span>Share within 24 hours. The contact must separately agree before Iris can send SMS.</span>
              </div>
            )}
            {principal?.role === "admin" && (
              <form className="compact-form" onSubmit={createTrustedContact}>
                <strong>Draft a trusted contact</strong>
                <input required placeholder="Display name" value={contactName} onChange={(event) => setContactName(event.target.value)} />
                <input required placeholder="Relationship" value={contactRelationship} onChange={(event) => setContactRelationship(event.target.value)} />
                <input required placeholder="Mobile in E.164" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} />
                <button className="secondary-button" type="submit" disabled={isCreatingContact}>{isCreatingContact ? "Saving…" : "Save draft"}</button>
              </form>
            )}
          </section>

          <section className="overview-card actions-card">
            <p className="card-kicker">Actions</p>
            <h2>Approval queue</h2>
            {overview.actions.length ? (
              <ol className="item-list">
                {overview.actions.map((action) => (
                  <li key={action.id}>
                    <strong>{actionLabel(action)}</strong>
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
