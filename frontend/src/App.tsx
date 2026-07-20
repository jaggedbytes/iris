import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  dashboardJson,
  dashboardRequest,
  DashboardError,
  publicJson,
} from "./dashboard";
import type { DashboardCallThread, DashboardOverview, DashboardPersonList, DashboardPrincipal } from "./dashboard";

const SESSION_TOKEN_KEY = "iris-dashboard-access-token";
const DASHBOARD_POLL_INTERVAL_MS = 2_500;
const ADD_PERSON_OPTION = "__add_person__";
const ADD_CONTACT_OPTION = "__add_contact__";
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
type DashboardPage = "home" | "activity";
let capturedOptInToken: string | null | undefined;

function dashboardPageFromPath(pathname: string): DashboardPage {
  return pathname === "/activity" ? "activity" : "home";
}

function pathForDashboardPage(page: DashboardPage) {
  return page === "activity" ? "/activity" : "/";
}

function callIdFromLocation() {
  if (window.location.pathname !== "/activity") return null;
  return new URL(window.location.href).searchParams.get("call");
}

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

function takeOptInToken() {
  if (capturedOptInToken !== undefined) return capturedOptInToken;
  const location = new URL(window.location.href);
  capturedOptInToken = location.searchParams.get("token");
  if (capturedOptInToken) {
    location.searchParams.delete("token");
    window.history.replaceState({}, "", location);
  }
  return capturedOptInToken;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function IrisSuggestions({ idPrefix, items }: { idPrefix: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="care-summary">
      <strong>Iris suggested</strong>
      <ul>{items.map((item, index) => <li key={`${idPrefix}-suggestion-${index}`}>{item}</li>)}</ul>
    </div>
  );
}

function summaryLabel(
  careSummary: DashboardOverview["calls"][number]["careSummary"],
  summaryState: DashboardOverview["calls"][number]["summaryState"],
  careSharingActive: boolean | null,
  privateSummarySaved?: boolean,
  callStatus?: string,
) {
  if (summaryState === "processing") return "Preparing shared care recap…";
  if (summaryState === "unavailable") return "Shared care recap unavailable";
  if (careSummary) return careSummary.recap;
  if (callStatus === "failed" && summaryState === "not_requested") return "No conversation";
  if (careSharingActive === false) {
    return privateSummarySaved
      ? "Private memory saved; shared care recaps are off"
      : "Shared care recaps are off";
  }
  return privateSummarySaved ? "Private memory saved; no shared care recap" : "No shared care recap";
}

function phoneNumberLabel(person: DashboardOverview["person"]) {
  if (person.phoneNumberStatus === "not_configured") return "Phone number not configured";
  return person.phoneE164 ?? "Phone number unavailable";
}

function contactPhoneLabel(phoneE164: string | null) {
  return phoneE164 ?? "Phone number not configured";
}

function givenName(displayName: string) {
  return displayName.trim().split(/\s+/).find(Boolean) ?? displayName;
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
    case "call.no_answer": return `${personName} did not answer`;
    case "call.stream_started": return "Iris began listening";
    case "call.completed": return "Call ended";
    case "call.failed": return "Call could not be completed";
    case "call.interrupted": return "Call was interrupted";
    case "call.summary_ready": return "Call summary is ready";
    case "call.summary_unavailable": return "Shared care recap unavailable";
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
  if (action.feature === "enrollment" && action.actionType === "sms_confirmation") return "SMS opt-in confirmation";
  return `${action.feature} · ${action.actionType}`;
}

function actionCopy(action: DashboardOverview["actions"][number]) {
  if (action.dispatchState === "needs_review") {
    return "Delivery is uncertain. Confirm with the recipient or Twilio before retrying.";
  }
  if (action.dispatchState === "retryable") return "This send can be retried manually.";
  if (action.dispatchState === "pending") return "Queued for sending.";
  if (action.dispatchState === "dispatching") return "Waiting for delivery confirmation.";
  if (action.dispatchState === "failed" || action.status === "failed") return "This message was not sent.";
  if (action.dispatchState === "dispatched") return "Message sent.";
  return action.status === "pending_approval" ? "Waiting for approval." : action.status;
}

function DashboardApp() {
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
  const [accessTokenError, setAccessTokenError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(token));
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [optInLink, setOptInLink] = useState<string | null>(null);
  const [optInInvitation, setOptInInvitation] = useState<{ createdAt: string; expiresAt: string } | null>(null);
  const [copiedLink, setCopiedLink] = useState<"dashboard" | "sms" | null>(null);
  const [adminPeople, setAdminPeople] = useState<DashboardPersonList>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [isAddingPerson, setIsAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonPhone, setNewPersonPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactRelationship, setContactRelationship] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [isCreatingPerson, setIsCreatingPerson] = useState(false);
  const [newPersonFormError, setNewPersonFormError] = useState<string | null>(null);
  const [newPersonErrorField, setNewPersonErrorField] = useState<"name" | "phone">("name");
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const [newContactFormError, setNewContactFormError] = useState<string | null>(null);
  const [newContactErrorField, setNewContactErrorField] = useState<"name" | "relationship" | "phone">("name");
  const [isRemovingPerson, setIsRemovingPerson] = useState(false);
  const [isRemovingContact, setIsRemovingContact] = useState(false);
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [isSavingPhone, setIsSavingPhone] = useState(false);
  const [phoneFormError, setPhoneFormError] = useState<string | null>(null);
  const [isEditingContactPhone, setIsEditingContactPhone] = useState(false);
  const [contactPhoneDraft, setContactPhoneDraft] = useState("");
  const [isSavingContactPhone, setIsSavingContactPhone] = useState(false);
  const [contactPhoneFormError, setContactPhoneFormError] = useState<string | null>(null);
  const [selectedTrustedContactId, setSelectedTrustedContactId] = useState("");
  const [attestedContactIds, setAttestedContactIds] = useState<Record<string, boolean>>({});
  const [contactAttestationErrorId, setContactAttestationErrorId] = useState<string | null>(null);
  const [consentAttested, setConsentAttested] = useState(false);
  const [draftPrivateMemory, setDraftPrivateMemory] = useState(false);
  const [draftSharedCare, setDraftSharedCare] = useState(false);
  const [savingConsents, setSavingConsents] = useState(false);
  const [consentFormError, setConsentFormError] = useState<string | null>(null);
  const [isCallRequesting, setIsCallRequesting] = useState(false);
  const [dispatchingActionId, setDispatchingActionId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [noteFormError, setNoteFormError] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(callIdFromLocation);
  const [callThread, setCallThread] = useState<DashboardCallThread | null>(null);
  const [isLoadingCallThread, setIsLoadingCallThread] = useState(false);
  const [callThreadError, setCallThreadError] = useState<string | null>(null);
  const [callNoteDraft, setCallNoteDraft] = useState("");
  const [isSavingCallNote, setIsSavingCallNote] = useState(false);
  const [callNoteFormError, setCallNoteFormError] = useState<string | null>(null);
  const [callThreadRefreshVersion, setCallThreadRefreshVersion] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dashboardPage, setDashboardPage] = useState<DashboardPage>(() =>
    dashboardPageFromPath(window.location.pathname),
  );
  const [dashboardNavOpen, setDashboardNavOpen] = useState(false);
  const magicLinkRequestId = useRef(0);
  const overviewRequestId = useRef(0);
  const callThreadRequestId = useRef(0);
  const callThreadPersonId = useRef<string | null>(null);
  const pendingTrustedContactId = useRef<string | null>(null);
  // Skip interval/visibility refreshes while an overview load is still running so
  // a slow response is not cancelled every 2.5s into an endless backlog.
  const overviewLoadInFlight = useRef(false);

  const personId = useMemo(() => {
    if (overview) return overview.person.id;
    if (principal) return principal.personId;
    return "";
  }, [overview, principal]);
  const careConsents = overview?.consents;
  const selectedTrustedContact = overview?.contacts.find(
    (contact) => contact.id === selectedTrustedContactId,
  ) ?? overview?.contacts[0] ?? null;
  const displayedOptInInvitation = optInInvitation ?? selectedTrustedContact?.smsOptInInvitation ?? null;
  const consentDirty = Boolean(
    careConsents
    && (draftPrivateMemory !== careConsents.summaryRetention
      || draftSharedCare !== careConsents.careSummarySharing),
  );

  useEffect(() => {
    if (!careConsents) return;
    setDraftPrivateMemory(careConsents.summaryRetention);
    setDraftSharedCare(careConsents.careSummarySharing);
    setConsentAttested(false);
    setConsentFormError(null);
  }, [personId, careConsents?.summaryRetention, careConsents?.careSummarySharing]);

  useEffect(() => {
    setNoteDraft("");
    setNoteFormError(null);
  }, [personId]);

  const clearCallThread = (historyMode: "push" | "replace" = "replace") => {
    callThreadRequestId.current += 1;
    setSelectedCallId(null);
    setCallThread(null);
    setCallThreadError(null);
    setCallNoteDraft("");
    setCallNoteFormError(null);
    const location = new URL(window.location.href);
    location.searchParams.delete("call");
    window.history[`${historyMode}State`]({}, "", `${location.pathname}${location.search}${location.hash}`);
  };

  const selectCallThread = (callId: string) => {
    if (selectedCallId === callId) {
      clearCallThread("push");
      return;
    }
    callThreadRequestId.current += 1;
    setSelectedCallId(callId);
    setCallThread(null);
    setCallThreadError(null);
    setCallNoteDraft("");
    setCallNoteFormError(null);
    const location = new URL(window.location.href);
    location.searchParams.set("call", callId);
    window.history.pushState({}, "", `${location.pathname}${location.search}${location.hash}`);
  };

  const trustedContactIds = overview?.contacts.map((contact) => contact.id).join("|") ?? "";

  useEffect(() => {
    const contacts = overview?.contacts ?? [];
    if (contacts.length === 0) {
      setSelectedTrustedContactId("");
      setIsAddingContact(principal?.role === "admin");
      return;
    }
    const pendingId = pendingTrustedContactId.current;
    if (pendingId) {
      if (!contacts.some((contact) => contact.id === pendingId)) return;
      pendingTrustedContactId.current = null;
      setSelectedTrustedContactId(pendingId);
      setIsAddingContact(false);
      return;
    }
    if (contacts.some((contact) => contact.id === selectedTrustedContactId)) return;
    setSelectedTrustedContactId(contacts[0]!.id);
    setIsAddingContact(false);
  }, [personId, trustedContactIds, principal?.role, selectedTrustedContactId]);

  const saveConsents = async () => {
    if (!personId || !careConsents || !consentDirty) return;
    if (!consentAttested) {
      setConsentFormError(`Confirm that ${overview?.person.displayName ?? "this person"} agreed to these choices before saving.`);
      return;
    }
    const wantPrivateMemory = draftPrivateMemory;
    const wantSharedCare = draftSharedCare && draftPrivateMemory;
    setSavingConsents(true);
    setConsentFormError(null);
    setError(null);
    try {
      const postConsent = (kind: "summary_retention" | "care_summary_sharing", status: "granted" | "revoked") =>
        dashboardJson(`/api/dashboard/people/${personId}/consents/${kind}`, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, operatorAttested: true }),
        });

      if (careConsents.careSummarySharing && !wantSharedCare) {
        await postConsent("care_summary_sharing", "revoked");
      }
      if (careConsents.summaryRetention !== wantPrivateMemory) {
        await postConsent("summary_retention", wantPrivateMemory ? "granted" : "revoked");
      }
      if (!careConsents.careSummarySharing && wantSharedCare) {
        await postConsent("care_summary_sharing", "granted");
      }

      setConsentAttested(false);
      setRefreshVersion((version) => version + 1);
    } catch (consentError) {
      setError(consentError instanceof Error ? consentError.message : "Unable to update consent.");
    } finally {
      setSavingConsents(false);
    }
  };

  const copyLink = async (link: string, kind: "dashboard" | "sms") => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(kind);
      window.setTimeout(() => setCopiedLink((current) => current === kind ? null : current), 2_000);
    } catch {
      setError("Unable to copy the link. Please select and copy it manually.");
    }
  };

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
        const people = nextPrincipal.role === "admin"
          ? await dashboardJson<{ people: DashboardPersonList }>("/api/dashboard/people", token)
          : null;

        if (nextPrincipal.role === "admin" && (people?.people.length ?? 0) === 0) {
          if (cancelled || requestId !== overviewRequestId.current) return;
          setPrincipal(nextPrincipal);
          setAdminPeople([]);
          setOverview(null);
          setSelectedPersonId(null);
          setIsAddingPerson(true);
          setError(null);
          return;
        }

        // Admin /me still names the configured demo id; after removal that row may be gone.
        // Prefer an explicit selection, then any still-existing people list entry.
        const adminFallbackId = people?.people.find((person) => person.id === selectedPersonId)?.id
          ?? people?.people.find((person) => person.id === nextPrincipal.personId)?.id
          ?? people?.people[0]?.id
          ?? null;
        const nextPersonId = nextPrincipal.role === "admin"
          ? adminFallbackId
          : nextPrincipal.personId;
        if (!nextPersonId) {
          throw new DashboardError("Add a person to start using the dashboard.", 404);
        }
        const nextOverview = await dashboardJson<DashboardOverview>(
          `/api/dashboard/people/${nextPersonId}/overview`,
          token,
        );
        if (cancelled || requestId !== overviewRequestId.current) return;
        setPrincipal(nextPrincipal);
        setOverview(nextOverview);
        if (people) {
          setAdminPeople(people.people);
          if (selectedPersonId !== nextPersonId) {
            setSelectedPersonId(nextPersonId);
          }
        }
        setError(null);
      } catch (loadError) {
        if (cancelled || requestId !== overviewRequestId.current) return;
        if (loadError instanceof DashboardError && loadError.isAuthError) {
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
          setToken("");
          setAccessTokenError(loadError.message);
          setError(null);
        } else {
          setError(loadError instanceof Error ? loadError.message : "Unable to load the dashboard.");
        }
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
  const selectedOverviewCall = overview?.calls.find((call) => call.id === selectedCallId) ?? null;

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

  const visibleCallIds = overview?.calls.map((call) => call.id).join("|") ?? "";

  useEffect(() => {
    if (!personId) return;
    if (callThreadPersonId.current && callThreadPersonId.current !== personId) {
      clearCallThread();
    }
    callThreadPersonId.current = personId;
  }, [personId]);

  useEffect(() => {
    if (dashboardPage !== "activity" || !selectedCallId || !overview) return;
    if (overview.calls.some((call) => call.id === selectedCallId)) return;
    // The URL may be stale, inaccessible, or point to a call that disappeared
    // after a person switch. Normalize it quietly rather than showing an error.
    clearCallThread();
  }, [dashboardPage, selectedCallId, visibleCallIds]);

  useEffect(() => {
    if (!selectedOverviewCall || !callThread) return;
    if (selectedOverviewCall.summaryState === callThread.call.summaryState) return;
    // The overview poll observed a meaningful summary-state change. Refresh the
    // open thread once, while retaining the last successful detail on screen.
    setCallThreadRefreshVersion((current) => current + 1);
  }, [selectedOverviewCall?.summaryState, callThread?.call.summaryState]);

  useEffect(() => {
    if (!token || !personId || dashboardPage !== "activity" || !selectedCallId || !selectedOverviewCall) {
      setIsLoadingCallThread(false);
      return;
    }
    let cancelled = false;
    const requestId = ++callThreadRequestId.current;
    setIsLoadingCallThread(true);
    setCallThreadError(null);
    void dashboardJson<DashboardCallThread>(
      `/api/dashboard/people/${personId}/calls/${selectedCallId}/thread`,
      token,
    ).then((thread) => {
      if (cancelled || requestId !== callThreadRequestId.current) return;
      setCallThread(thread);
    }).catch((threadError) => {
      if (cancelled || requestId !== callThreadRequestId.current) return;
      if (threadError instanceof DashboardError && (threadError.status === 403 || threadError.status === 404)) {
        clearCallThread();
        return;
      }
      setCallThread(null);
      setCallThreadError(threadError instanceof Error ? threadError.message : "Unable to load this call.");
    }).finally(() => {
      if (!cancelled && requestId === callThreadRequestId.current) {
        setIsLoadingCallThread(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, personId, dashboardPage, selectedCallId, selectedOverviewCall?.id, callThreadRefreshVersion]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = adminTokenInput.trim();
    if (!nextToken) {
      setAccessTokenError("Enter your operator access token to open the dashboard.");
      return;
    }
    setAccessTokenError(null);
    sessionStorage.setItem(SESSION_TOKEN_KEY, nextToken);
    setToken(nextToken);
  };

  const signOut = () => {
    magicLinkRequestId.current += 1;
    overviewRequestId.current += 1;
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setToken("");
    setAccessTokenError(null);
    setError(null);
    setMagicLink(null);
    setOptInLink(null);
    setSelectedPersonId(null);
    setIsAddingPerson(false);
    setAdminPeople([]);
    setDashboardPage("home");
    setDashboardNavOpen(false);
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
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
            scopes: ["care_notes", "view_summaries", "view_events", "request_check_in"],
          }),
        },
      );
      if (requestId === magicLinkRequestId.current) {
        setMagicLink(result.magicLink);
        setRefreshVersion((current) => current + 1);
      }
    } catch (linkError) {
      if (requestId === magicLinkRequestId.current) {
        setError(linkError instanceof Error ? linkError.message : "Unable to create a link.");
      }
    }
  };

  const revokeDashboardGrant = async (grantId: string) => {
    setError(null);
    try {
      await dashboardRequest(`/api/dashboard/access-grants/${grantId}`, token, { method: "DELETE" }).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new DashboardError(body?.error ?? "Unable to revoke the dashboard link.", response.status);
        }
      });
      setMagicLink(null);
      setRefreshVersion((current) => current + 1);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Unable to revoke the dashboard link.");
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

  const addCareNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId) return;
    const body = noteDraft.trim();
    if (!body) {
      setNoteFormError("Enter a note before saving.");
      return;
    }
    setIsSavingNote(true);
    setNoteFormError(null);
    setError(null);
    try {
      await dashboardJson(`/api/dashboard/people/${personId}/notes`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setNoteDraft("");
      setRefreshVersion((current) => current + 1);
    } catch (noteError) {
      setNoteFormError(noteError instanceof Error ? noteError.message : "Unable to save this note.");
    } finally {
      setIsSavingNote(false);
    }
  };

  const addCallNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId || !selectedCallId) return;
    const body = callNoteDraft.trim();
    if (!body) {
      setCallNoteFormError("Enter a note before saving.");
      return;
    }
    setIsSavingCallNote(true);
    setCallNoteFormError(null);
    try {
      await dashboardJson(`/api/dashboard/people/${personId}/calls/${selectedCallId}/notes`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setCallNoteDraft("");
      setCallThreadRefreshVersion((current) => current + 1);
      setRefreshVersion((current) => current + 1);
    } catch (noteError) {
      setCallNoteFormError(noteError instanceof Error ? noteError.message : "Unable to save this note.");
    } finally {
      setIsSavingCallNote(false);
    }
  };

  const createPerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreatingPerson(true);
    setNewPersonFormError(null);
    setError(null);
    try {
      const result = await dashboardJson<{ person: { id: string } }>("/api/dashboard/people", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: newPersonName, phoneE164: newPersonPhone || null }),
      });
      setNewPersonName("");
      setNewPersonPhone("");
      setNewPersonFormError(null);
      setIsAddingPerson(false);
      setOverview(null);
      setSelectedPersonId(result.person.id);
      setSelectedTrustedContactId("");
      setAttestedContactIds({});
      setContactAttestationErrorId(null);
      setMagicLink(null);
      setOptInLink(null);
      setOptInInvitation(null);
      setRefreshVersion((current) => current + 1);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Unable to create the person.";
      setNewPersonErrorField(/display name|enter a name/i.test(message) ? "name" : "phone");
      setNewPersonFormError(message);
    } finally {
      setIsCreatingPerson(false);
    }
  };

  const createTrustedContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId) return;
    setIsCreatingContact(true);
    setNewContactFormError(null);
    setError(null);
    try {
      const result = await dashboardJson<{
        contact: {
          id: string;
          displayName: string;
          relationship: string;
          phoneE164: string | null;
        };
        smsOptInStatus: "not_opted_in";
      }>(`/api/dashboard/people/${personId}/trusted-contacts`, token, {
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
      setNewContactFormError(null);
      pendingTrustedContactId.current = result.contact.id;
      setIsAddingContact(false);
      setSelectedTrustedContactId(result.contact.id);
      setOverview((current) => current
        ? {
            ...current,
            contacts: [
              ...current.contacts,
              {
                id: result.contact.id,
                displayName: result.contact.displayName,
                relationship: result.contact.relationship,
                phoneE164: result.contact.phoneE164,
                smsOptInStatus: result.smsOptInStatus,
                optInLinkState: "none",
                confirmationState: "not_requested",
                smsOptInInvitation: null,
                dashboardGrant: null,
              },
            ],
          }
        : current);
      setRefreshVersion((current) => current + 1);
    } catch (contactError) {
      const message = contactError instanceof Error ? contactError.message : "Unable to draft the trusted contact.";
      setNewContactErrorField(
        /relationship/i.test(message) ? "relationship" : /name/i.test(message) ? "name" : "phone",
      );
      setNewContactFormError(message);
    } finally {
      setIsCreatingContact(false);
    }
  };

  const saveContactPhone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId || !selectedTrustedContact) return;
    setIsSavingContactPhone(true);
    setContactPhoneFormError(null);
    setError(null);
    try {
      const result = await dashboardJson<{ contact: { phoneE164: string } }>(
        `/api/dashboard/people/${personId}/trusted-contacts/${selectedTrustedContact.id}/phone`,
        token,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneE164: contactPhoneDraft }),
        },
      );
      setOverview((current) => current
        ? {
            ...current,
            contacts: current.contacts.map((contact) => contact.id === selectedTrustedContact.id
              ? { ...contact, phoneE164: result.contact.phoneE164 }
              : contact),
          }
        : current);
      setIsEditingContactPhone(false);
    } catch (phoneError) {
      setContactPhoneFormError(phoneError instanceof Error ? phoneError.message : "Unable to save the phone number.");
    } finally {
      setIsSavingContactPhone(false);
    }
  };

  const removeSelectedContact = async () => {
    if (!personId || !selectedTrustedContact) return;
    if (!window.confirm(`Remove ${selectedTrustedContact.displayName}? This removes their dashboard links and SMS invitation state.`)) {
      return;
    }

    setIsRemovingContact(true);
    setError(null);
    try {
      await dashboardRequest(
        `/api/dashboard/people/${personId}/trusted-contacts/${selectedTrustedContact.id}`,
        token,
        { method: "DELETE" },
      ).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new DashboardError(body?.error ?? "Unable to remove this trusted contact.", response.status);
        }
      });
      const removedId = selectedTrustedContact.id;
      pendingTrustedContactId.current = null;
      setMagicLink(null);
      setOptInLink(null);
      setOptInInvitation(null);
      setIsEditingContactPhone(false);
      setContactPhoneFormError(null);
      setOverview((current) => {
        if (!current) return current;
        const contacts = current.contacts.filter((contact) => contact.id !== removedId);
        return { ...current, contacts };
      });
      setSelectedTrustedContactId("");
      setIsAddingContact(false);
      setRefreshVersion((current) => current + 1);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove this trusted contact.");
    } finally {
      setIsRemovingContact(false);
    }
  };

  const removeSelectedPerson = async () => {
    if (!personId || !overview) return;
    if (!window.confirm(`Remove ${overview.person.displayName}? This removes their trusted contacts, calls, and saved information.`)) {
      return;
    }

    const remaining = adminPeople.filter((person) => person.id !== personId);
    setIsRemovingPerson(true);
    setError(null);
    try {
      await dashboardRequest(`/api/dashboard/people/${personId}`, token, { method: "DELETE" }).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new DashboardError(body?.error ?? "Unable to remove this person.", response.status);
        }
      });
      setOverview(null);
      setAdminPeople(remaining);
      setSelectedTrustedContactId("");
      setAttestedContactIds({});
      setContactAttestationErrorId(null);
      setMagicLink(null);
      setOptInLink(null);
      setOptInInvitation(null);
      setIsEditingPhone(false);
      if (remaining[0]) {
        setIsAddingPerson(false);
        setSelectedPersonId(remaining[0].id);
      } else {
        setSelectedPersonId(null);
        setIsAddingPerson(true);
      }
      setRefreshVersion((current) => current + 1);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove this person.");
    } finally {
      setIsRemovingPerson(false);
    }
  };

  const savePersonPhone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!personId) return;
    setIsSavingPhone(true);
    setPhoneFormError(null);
    setError(null);
    try {
      const result = await dashboardJson<{ person: { phoneE164: string } }>(
        `/api/dashboard/people/${personId}/phone`,
        token,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneE164: phoneDraft }),
        },
      );
      setOverview((current) => current
        ? {
            ...current,
            person: { ...current.person, phoneE164: result.person.phoneE164, phoneNumberStatus: "configured" },
          }
        : current);
      setAdminPeople((people) => people.map((person) => person.id === personId
        ? { ...person, phoneNumberStatus: "configured" }
        : person));
      setIsEditingPhone(false);
    } catch (phoneError) {
      setPhoneFormError(phoneError instanceof Error ? phoneError.message : "Unable to save the phone number.");
    } finally {
      setIsSavingPhone(false);
    }
  };

  const createOptInLink = async (trustedContactId: string) => {
    if (!personId) return;
    setOptInLink(null);
    setOptInInvitation(null);
    setError(null);
    try {
      const result = await dashboardJson<{
        optInLink: string;
        invitation: { createdAt: string; expiresAt: string };
      }>(
        `/api/dashboard/people/${personId}/trusted-contacts/${trustedContactId}/opt-in-invitations`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operatorAttested: attestedContactIds[trustedContactId] === true }),
        },
      );
      setOptInLink(result.optInLink);
      setOptInInvitation(result.invitation);
      setOverview((current) => current
        ? {
            ...current,
            contacts: current.contacts.map((contact) => contact.id === trustedContactId
              ? {
                  ...contact,
                  optInLinkState: "active",
                  smsOptInInvitation: result.invitation,
                }
              : contact),
          }
        : current);
      setRefreshVersion((current) => current + 1);
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
  const isOperator = principal?.role === "admin";
  const isTrusted = principal?.role === "trusted_contact";
  const showHomeCards = dashboardPage === "home";
  const showActivityCards = dashboardPage === "activity";

  const goToDashboardPage = (page: DashboardPage) => {
    setDashboardPage(page);
    setDashboardNavOpen(false);
    const nextPath = pathForDashboardPage(page);
    if (page === "home") {
      callThreadRequestId.current += 1;
      setSelectedCallId(null);
      setCallThread(null);
      setCallThreadError(null);
      setCallNoteDraft("");
      setCallNoteFormError(null);
    }
    if (window.location.pathname !== nextPath || window.location.search) {
      window.history.pushState({}, "", nextPath);
    }
  };

  useEffect(() => {
    const onPopState = () => {
      const nextPage = dashboardPageFromPath(window.location.pathname);
      setDashboardPage(nextPage);
      setSelectedCallId(nextPage === "activity" ? callIdFromLocation() : null);
      setCallThread(null);
      setCallThreadError(null);
      setCallNoteDraft("");
      setCallNoteFormError(null);
      setDashboardNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!dashboardNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDashboardNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dashboardNavOpen]);

  const personCard = overview ? (
    <section className="overview-card profile-card">
      <div className="card-header">
        <p className="card-kicker">Person</p>
        <h2>{overview.person.displayName}</h2>
        <div className="person-phone-row">
          <p className="person-phone">{phoneNumberLabel(overview.person)}</p>
          {principal?.role === "admin" && (
            <button
              className="person-phone-edit"
              type="button"
              onClick={() => {
                setPhoneDraft(overview.person.phoneE164 ?? "");
                setPhoneFormError(null);
                setIsEditingPhone(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
        {principal?.role === "admin" && isEditingPhone && (
          <form className="phone-editor" onSubmit={savePersonPhone}>
            <label className="form-field">
              Phone number
              <input required placeholder="E.164, e.g. +15551234567" value={phoneDraft} onChange={(event) => {
                setPhoneDraft(event.target.value);
                setPhoneFormError(null);
              }} />
              {phoneFormError && <p className="form-validation-error" role="alert">{phoneFormError}</p>}
            </label>
            <div className="phone-editor-actions">
              <button className="secondary-button" type="submit" disabled={isSavingPhone}>{isSavingPhone ? "Saving…" : "Save"}</button>
              <button className="secondary-button" type="button" disabled={isSavingPhone} onClick={() => {
                setPhoneFormError(null);
                setIsEditingPhone(false);
              }}>Cancel</button>
            </div>
          </form>
        )}
        {principal?.role === "admin" ? (
          <p className="privacy-note">Choose what Iris remembers and what your care circle can see. Iris never saves raw audio or full transcripts.</p>
        ) : (
          <p className="privacy-note">Iris never saves raw audio or full transcripts.</p>
        )}
      </div>
      {principal?.role === "admin" && careConsents && (
        <div className="compact-form consent-choices">
          <strong>Conversation preferences</strong>
          <label className="consent-check">
            <input
              className="consent-toggle"
              type="checkbox"
              checked={draftPrivateMemory}
              onChange={(event) => {
                const enabled = event.target.checked;
                setDraftPrivateMemory(enabled);
                if (!enabled) setDraftSharedCare(false);
              }}
            />
            <span className="consent-option">
              <span className="consent-option-heading">
                <strong>Private memory</strong>
                <span className={`consent-status${careConsents.summaryRetention ? "" : " is-off"}`} aria-label={careConsents.summaryRetention ? "Currently on" : "Currently off"}>{careConsents.summaryRetention ? "On" : "Off"}</span>
              </span>
              <span>Helps Iris remember helpful details between calls. Only Iris uses this.</span>
            </span>
          </label>
          <label className="consent-check">
            <input
              className="consent-toggle"
              type="checkbox"
              checked={draftSharedCare}
              onChange={(event) => {
                const enabled = event.target.checked;
                setDraftSharedCare(enabled);
                if (enabled) setDraftPrivateMemory(true);
              }}
            />
            <span className="consent-option">
              <span className="consent-option-heading">
                <strong>Shared care recaps</strong>
                <span className={`consent-status${careConsents.careSummarySharing ? "" : " is-off"}`} aria-label={careConsents.careSummarySharing ? "Currently on" : "Currently off"}>{careConsents.careSummarySharing ? "On" : "Off"}</span>
              </span>
              <span>Shares a concise recap with you and trusted contacts, including health-related concerns and Iris’s guidance. Never raw audio or a full transcript. Requires private memory.</span>
            </span>
          </label>
          <div className="consent-attestation">
            <label className="consent-check">
              <input
                className="consent-toggle"
                type="checkbox"
                checked={consentAttested}
                onChange={(event) => {
                  setConsentAttested(event.target.checked);
                  if (event.target.checked) setConsentFormError(null);
                }}
              />
              <span>I confirm {overview.person.displayName} agreed to these choices.</span>
            </label>
            {consentFormError && <p className="consent-form-error" role="alert">{consentFormError}</p>}
          </div>
          <button
            className="secondary-button save-consent-button"
            type="button"
            disabled={!consentDirty || savingConsents}
            onClick={() => void saveConsents()}
          >
            {savingConsents ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </section>
  ) : null;

  const canViewSummaries = overview?.permissions.includes("view_summaries") ?? false;
  const canUseCareNotes = overview?.permissions.includes("care_notes") ?? false;
  const canViewThreadEvents = overview?.permissions.includes("view_events") ?? false;
  const callThreadFeed = callThread ? [
    ...callThread.events.map((event) => ({ id: `event-${event.id}`, kind: "event" as const, occurredAt: event.occurredAt, event })),
    ...callThread.notes.map((note) => ({ id: `note-${note.id}`, kind: "note" as const, occurredAt: note.createdAt, note })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)) : [];

  const recentCallsCard = overview && canViewSummaries ? (
    <section className="overview-card recent-calls-card">
      <div className="card-heading">
        <div className="card-header">
          <p className="card-kicker">Recent calls</p>
          <h2>Calls with Iris</h2>
          <p className="privacy-note">Shared notes from recent calls.</p>
        </div>
        <span className="count-pill">{overview.calls.length}</span>
      </div>
      {overview.calls.length ? (
        <ol className="call-thread-list">
          {overview.calls.map((call) => (
            <li key={call.id} className={`call-thread-item${selectedCallId === call.id ? " is-open" : ""}`}>
              <button
                className="call-thread-toggle"
                type="button"
                aria-expanded={selectedCallId === call.id}
                aria-controls={`call-thread-${call.id}`}
                onClick={() => selectCallThread(call.id)}
              >
                <span>
                  <strong>{summaryLabel(
                    call.careSummary,
                    call.summaryState,
                    careConsents?.careSummarySharing ?? null,
                    call.privateSummarySaved,
                    call.status,
                  )}</strong>
                  <span>{formatDate(call.startedAt)} · {call.status}</span>
                </span>
                <span className="call-thread-chevron" aria-hidden="true">{selectedCallId === call.id ? "−" : "+"}</span>
              </button>
              {selectedCallId === call.id && (
                <div id={`call-thread-${call.id}`} className="call-thread-detail">
                  {isLoadingCallThread && !callThread && <p className="loading-note">Loading this call…</p>}
                  {callThreadError && <p className="form-validation-error" role="alert">{callThreadError}</p>}
                  {callThread && (
                    <>
                      <div className="call-thread-recap">
                        <strong>Conversation recap</strong>
                        <p>{summaryLabel(
                          callThread.call.careSummary,
                          callThread.call.summaryState,
                          careConsents?.careSummarySharing ?? null,
                          callThread.call.privateSummarySaved,
                          callThread.call.status,
                        )}</p>
                        {callThread.call.careSummary && (
                          <>
                            {callThread.call.careSummary.moodAndConcerns.length > 0 && (
                              <div className="care-summary">
                                <strong>{givenName(overview.person.displayName)} shared</strong>
                                <ul>{callThread.call.careSummary.moodAndConcerns.map((item, index) => <li key={`${call.id}-thread-mood-${index}`}>{item}</li>)}</ul>
                              </div>
                            )}
                            <IrisSuggestions idPrefix={`${call.id}-thread`} items={callThread.call.careSummary.irisSuggestedNextSteps} />
                          </>
                        )}
                      </div>
                      {canViewThreadEvents || canUseCareNotes ? (
                        <div className="call-thread-activity">
                          <strong>Call activity</strong>
                          {callThreadFeed.length ? (
                            <ol className="item-list">
                              {callThreadFeed.map((item) => item.kind === "event" ? (
                                <li key={item.id}>
                                  <strong>{timelineCopy(item.event, overview.person.displayName)}</strong>
                                  <span>{formatDate(item.occurredAt)}</span>
                                </li>
                              ) : (
                                <li key={item.id}>
                                  <strong>{item.note.authorDisplayName}{item.note.authorRelationship ? ` · ${item.note.authorRelationship}` : ""}</strong>
                                  <span>{formatDate(item.occurredAt)}</span>
                                  <p className="care-note-body">{item.note.body}</p>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <div className="empty-state-card"><p className="empty-state">No call activity yet.</p></div>
                          )}
                        </div>
                      ) : (
                        <div className="empty-state-card"><p className="empty-state">Call activity is not included with this link.</p></div>
                      )}
                      {canUseCareNotes && (
                        <form className="compact-form notes-form call-thread-note-form" noValidate onSubmit={addCallNote}>
                          <label className="form-field" htmlFor={`call-note-${call.id}`}>
                            Add a note
                            <span>Share an update about this call with the care circle.</span>
                            <textarea
                              id={`call-note-${call.id}`}
                              value={callNoteDraft}
                              maxLength={1000}
                              placeholder="e.g. I will check in after dinner."
                              onChange={(event) => {
                                setCallNoteDraft(event.target.value);
                                setCallNoteFormError(null);
                              }}
                            />
                            {callNoteFormError && <p className="form-validation-error" role="alert">{callNoteFormError}</p>}
                          </label>
                          <button className="secondary-button full-width-action" type="submit" disabled={isSavingCallNote}>
                            {isSavingCallNote ? "Saving…" : "Save note"}
                          </button>
                        </form>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-state-card">
          <p className="empty-state">Shared notes from calls with Iris will appear here.</p>
        </div>
      )}
    </section>
  ) : null;

  const visibleIrisNotes = overview?.calls.filter((call) => call.careSummary) ?? [];
  const careNotes = overview?.notes ?? [];
  const notesFeed = [
    ...visibleIrisNotes.map((call) => ({
      id: `iris-${call.id}`,
      kind: "iris" as const,
      occurredAt: call.startedAt,
      recap: call.careSummary!.recap,
      suggestions: call.careSummary!.irisSuggestedNextSteps,
    })),
    ...careNotes.map((note) => ({
      id: `note-${note.id}`,
      kind: "note" as const,
      occurredAt: note.createdAt,
      authorDisplayName: note.authorDisplayName,
      authorRelationship: note.authorRelationship,
      body: note.body,
    })),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  const notesCard = overview && canUseCareNotes ? (
    <section className="overview-card notes-card">
      <div className="card-heading">
        <div className="card-header">
          <p className="card-kicker">Notes</p>
          <h2>Care-circle updates</h2>
          <p className="privacy-note">Keep track of recent Iris calls and the ways your care circle has connected.</p>
        </div>
        <span className="count-pill">{notesFeed.length}</span>
      </div>
      <div className="last-check-in">
        <strong>Last check-in</strong>
        <span>{overview.lastCheckInAt ? formatDate(overview.lastCheckInAt) : "No check-in yet"}</span>
      </div>
      {notesFeed.length > 0 ? (
        <div className="notes-feed">
          <ol className="item-list">
            {notesFeed.map((item) => item.kind === "iris" ? (
              <li key={item.id}>
                <strong>Iris call</strong>
                <span>{formatDate(item.occurredAt)}</span>
                <p className="care-note-body">{item.recap}</p>
                <IrisSuggestions idPrefix={item.id} items={item.suggestions} />
              </li>
            ) : (
              <li key={item.id}>
                <strong>{item.authorDisplayName}{item.authorRelationship ? ` · ${item.authorRelationship}` : ""}</strong>
                <span>{formatDate(item.occurredAt)}</span>
                <p className="care-note-body">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="empty-state-card">
          <p className="empty-state">Care-circle updates will appear here.</p>
        </div>
      )}
      <form className="compact-form notes-form" noValidate onSubmit={addCareNote}>
        <label className="form-field" htmlFor="care-note">
          Add a note
          <span>Share a quick update with this person’s care circle.</span>
          <textarea
            id="care-note"
            value={noteDraft}
            maxLength={1000}
            placeholder="e.g. I called after dinner and they sounded in good spirits."
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setNoteFormError(null);
            }}
          />
          {noteFormError && <p className="form-validation-error" role="alert">{noteFormError}</p>}
        </label>
        <button className="secondary-button full-width-action" type="submit" disabled={isSavingNote}>
          {isSavingNote ? "Saving…" : "Save note"}
        </button>
      </form>
    </section>
  ) : null;

  const timelineCard = overview ? (
    <section className="overview-card timeline-card dashboard-split-aside">
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
        <div className="empty-state-card">
          <p className="empty-state">Iris activity will appear here.</p>
        </div>
      )}
    </section>
  ) : null;

  const actionsCard = overview ? (
    <section className="overview-card actions-card">
      <div className="card-header">
        <p className="card-kicker">Actions</p>
        <h2>Text messages</h2>
        <p className="privacy-note">Message updates and anything that needs your attention.</p>
      </div>
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
        <div className="empty-state-card">
          <p className="empty-state">No text-message updates yet.</p>
        </div>
      )}
    </section>
  ) : null;

  const trustedSelfCard = overview?.viewer ? (
    <section className="overview-card trusted-self-card dashboard-split-aside">
      <div className="card-header">
        <p className="card-kicker">You</p>
        <h2>{overview.viewer.displayName}</h2>
        <span className="contact-relationship">{overview.viewer.relationship}</span>
        <div className="person-phone-row">
          <p className="person-phone">{contactPhoneLabel(overview.viewer.phoneE164)}</p>
        </div>
      </div>
      <div className="trusted-self-sms">
        <strong>Text messages</strong>
        <p className="privacy-note">Iris can text you for Shield safety alerts once you’ve opted in. An operator sends you an opt-in link to get started.</p>
        <ul className="contact-status-list">
          <li>
            <span>
              <strong>SMS</strong>
              <span className="contact-status-detail">Whether you’ve agreed to receive Iris texts, including Shield alerts.</span>
            </span>
            <span className={`contact-status-pill${overview.viewer.smsOptInStatus === "opted_in" ? "" : " is-off"}`}>
              {overview.viewer.smsOptInStatus === "opted_in" ? "Opted in" : overview.viewer.smsOptInStatus === "opted_out" ? "Opted out" : "Not opted in"}
            </span>
          </li>
          <li>
            <span>
              <strong>SMS confirmation</strong>
              <span className="contact-status-detail">Whether Iris has sent the confirmation text after you use the opt-in link.</span>
            </span>
            <span className={`contact-status-pill${overview.viewer.confirmationState === "not_requested" ? " is-off" : ""}`}>
              {overview.viewer.confirmationState === "not_requested" ? "Not requested" : overview.viewer.confirmationState.replaceAll("_", " ")}
            </span>
          </li>
        </ul>
      </div>
      <div className="compact-form consent-choices is-readonly">
        <strong>Conversation preferences</strong>
        <p className="privacy-note">These choices were set for {overview.person.displayName}. Contact the Iris operator if you’d like them changed.</p>
        <div className="consent-check">
          <span className="consent-option">
            <span className="consent-option-heading">
              <strong>Private memory</strong>
              <span className={`consent-status${overview.consents.summaryRetention ? "" : " is-off"}`} aria-label={overview.consents.summaryRetention ? "Currently on" : "Currently off"}>
                {overview.consents.summaryRetention ? "On" : "Off"}
              </span>
            </span>
            <span>Helps Iris remember helpful details between calls. Only Iris uses this.</span>
          </span>
        </div>
        <div className="consent-check">
          <span className="consent-option">
            <span className="consent-option-heading">
              <strong>Shared care recaps</strong>
              <span className={`consent-status${overview.consents.careSummarySharing ? "" : " is-off"}`} aria-label={overview.consents.careSummarySharing ? "Currently on" : "Currently off"}>
                {overview.consents.careSummarySharing ? "On" : "Off"}
              </span>
            </span>
            <span>Shares a concise recap with you and trusted contacts, including health-related concerns and Iris’s guidance. Never raw audio or a full transcript. Requires private memory.</span>
          </span>
        </div>
      </div>
    </section>
  ) : null;

  if (!token && !isLoading) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="access-title">
          <p className="eyebrow">Iris companion</p>
          <h1 id="access-title">Trusted dashboard access.</h1>
          <p className="access-introduction">
            Use an operator access token to manage people, trusted contacts, and Iris calls. Family members can use a private link to see shared updates and request a check-in.
          </p>
          <form noValidate onSubmit={signIn}>
            <label htmlFor="admin-token">Operator access token</label>
            <input
              id="admin-token"
              type="password"
              value={adminTokenInput}
              onChange={(event) => {
                setAdminTokenInput(event.target.value);
                setAccessTokenError(null);
              }}
              autoComplete="current-password"
              aria-invalid={Boolean(accessTokenError)}
              aria-describedby={accessTokenError ? "admin-token-error" : undefined}
            />
            {accessTokenError && (
              <p id="admin-token-error" className="form-validation-error" role="alert">{accessTokenError}</p>
            )}
            <button type="submit">Open dashboard</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Iris companion</p>
          <h1>{overview?.person.displayName ?? (principal?.role === "admin" ? "Iris" : "Loading Iris…")}</h1>
          <p className="header-subtitle">
            {principal?.role === "admin"
              ? "Operator view"
              : `Trusted view for ${principal?.trustedContact?.displayName ?? "family"}`}
          </p>
          {principal?.role === "admin" && (
            <button
              className="call-button header-call-mobile"
              type="button"
              disabled={callDisabled}
              onClick={() => void startCall()}
            >
              {callStateLabel}
            </button>
          )}
          {canRequestCheckIn && (
            <button
              className="call-button header-call-mobile"
              type="button"
              disabled={callDisabled}
              onClick={() => void startCall()}
            >
              {activeCall ? callStateLabel : "Ask Iris to check in"}
            </button>
          )}
        </div>
        <div className="header-actions">
          {principal?.role === "admin" && (
            <button
              className="call-button header-call-desktop"
              type="button"
              disabled={callDisabled}
              onClick={() => void startCall()}
            >
              {callStateLabel}
            </button>
          )}
          {canRequestCheckIn && (
            <button
              className="call-button header-call-desktop"
              type="button"
              disabled={callDisabled}
              onClick={() => void startCall()}
            >
              {activeCall ? callStateLabel : "Ask Iris to check in"}
            </button>
          )}
          <div className="header-menu">
            <button
              type="button"
              className="nav-menu-button"
              aria-expanded={dashboardNavOpen}
              aria-controls="dashboard-nav-menu"
              onClick={() => setDashboardNavOpen((open) => !open)}
            >
              <span className="sr-only">{dashboardNavOpen ? "Close menu" : "Open menu"}</span>
              <span className="nav-menu-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>
            {dashboardNavOpen && (
              <div id="dashboard-nav-menu" className="dashboard-nav-panel" role="menu">
                <a
                  href="/"
                  role="menuitem"
                  className={`nav-link${dashboardPage === "home" ? " is-active" : ""}`}
                  aria-current={dashboardPage === "home" ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    goToDashboardPage("home");
                  }}
                >
                  Home
                </a>
                <a
                  href="/activity"
                  role="menuitem"
                  className={`nav-link${dashboardPage === "activity" ? " is-active" : ""}`}
                  aria-current={dashboardPage === "activity" ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    goToDashboardPage("activity");
                  }}
                >
                  Activity
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className="nav-link"
                  onClick={() => {
                    setDashboardNavOpen(false);
                    signOut();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
          <button className="text-button header-sign-out-desktop" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="dashboard-nav" aria-label="Dashboard pages">
        <div className="dashboard-nav-links" role="presentation">
          <a
            href="/"
            className={`nav-link${dashboardPage === "home" ? " is-active" : ""}`}
            aria-current={dashboardPage === "home" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              goToDashboardPage("home");
            }}
          >
            Home
          </a>
          <a
            href="/activity"
            className={`nav-link${dashboardPage === "activity" ? " is-active" : ""}`}
            aria-current={dashboardPage === "activity" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              goToDashboardPage("activity");
            }}
          >
            Activity
          </a>
        </div>
      </nav>

      {error && <p className="form-error" role="alert">{error}</p>}
      {isLoading && <p className="loading-note">Loading the current picture…</p>}
      {activeCall && (
        <p className="call-status" aria-live="polite">
          {activeCall.status === "answered" ? "Iris is on a call now." : "Iris is calling now."}
        </p>
      )}

      {(overview || (principal?.role === "admin" && (isAddingPerson || adminPeople.length === 0))) && (
        <div className="dashboard-grid is-dashboard-split">
          {isOperator && showHomeCards && (
            <div className="operator-home-primary">
            <section className="overview-card enrollment-card">
              <div className="enrollment-header">
                <p className="card-kicker">Enrollment</p>
                <h2>People and invitations</h2>
                <p className="privacy-note">Add the person Iris will call. Then invite trusted contacts and create their SMS opt-in links.</p>
              </div>
              <div className="person-picker">
                <strong>Person</strong>
                <span>{isAddingPerson ? "Fill in the form below, then save to add them to Iris." : "Select who will receive calls, invitations, and other actions."}</span>
                <label className="sr-only" htmlFor="person-select">Person</label>
                <select
                  id="person-select"
                  value={isAddingPerson || adminPeople.length === 0 ? ADD_PERSON_OPTION : personId}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === ADD_PERSON_OPTION) {
                      setIsAddingPerson(true);
                      setNewPersonFormError(null);
                      return;
                    }
                    setIsAddingPerson(false);
                    setNewPersonFormError(null);
                    pendingTrustedContactId.current = null;
                    setSelectedPersonId(value);
                    setOptInLink(null);
                    setOptInInvitation(null);
                    setMagicLink(null);
                  }}
                >
                  {adminPeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
                  <option value={ADD_PERSON_OPTION}>Add a person…</option>
                </select>
                {!isAddingPerson && overview && (
                  <button
                    className="remove-person-button"
                    type="button"
                    disabled={isRemovingPerson}
                    onClick={() => void removeSelectedPerson()}
                  >
                    {isRemovingPerson ? "Removing…" : "Remove person"}
                  </button>
                )}
              </div>
              {isAddingPerson && (
                <form className="compact-form" onSubmit={createPerson}>
                  <strong>Add a person</strong>
                  <label className="form-field">
                    Name
                    <input required placeholder="e.g. Avery Morgan" value={newPersonName} onChange={(event) => {
                      setNewPersonName(event.target.value);
                      if (newPersonErrorField === "name") setNewPersonFormError(null);
                    }} />
                    {newPersonFormError && newPersonErrorField === "name" && <p className="form-validation-error" role="alert">{newPersonFormError}</p>}
                  </label>
                  <label className="form-field">
                    Phone number
                    <span>Optional for a dashboard-only profile. Add a number before Iris can call this person.</span>
                    <input placeholder="E.164, e.g. +15551234567" value={newPersonPhone} onChange={(event) => {
                      setNewPersonPhone(event.target.value);
                      if (newPersonErrorField === "phone") setNewPersonFormError(null);
                    }} />
                    {newPersonFormError && newPersonErrorField === "phone" && <p className="form-validation-error" role="alert">{newPersonFormError}</p>}
                  </label>
                  <button className="secondary-button create-person-button" type="submit" disabled={isCreatingPerson}>
                    {isCreatingPerson ? "Adding…" : "Add person"}
                  </button>
                </form>
              )}
            </section>
            {personCard}
            </div>
          )}
          {isTrusted && showHomeCards && (
            <div className="dashboard-column-stack trusted-home-primary">
              {personCard}
              {trustedSelfCard}
            </div>
          )}

          {showActivityCards && overview && (
            <>
              <div className="dashboard-column-stack">
                {isOperator ? (
                  <>
                    {actionsCard}
                    {recentCallsCard}
                  </>
                ) : (
                  <>
                    {recentCallsCard}
                    {actionsCard}
                  </>
                )}
              </div>
              {timelineCard}
            </>
          )}

          {isOperator && showHomeCards && overview && (
          <div className="operator-home-secondary">
            <section className="overview-card trusted-contacts-card dashboard-split-aside">
              <div className="card-header">
                <p className="card-kicker">Trusted contacts</p>
                <h2>People in the circle</h2>
                <p className="privacy-note">Add the people who can stay connected with {overview.person.displayName}. They can receive a dashboard link, request an Iris check-in, and choose whether to receive text messages.</p>
              </div>
                <div className="trusted-contact-picker">
                  <strong>Trusted contact</strong>
                  <span>{isAddingContact ? "Fill in the form below, then save to add them to the care circle." : "Choose who the dashboard and SMS actions below apply to."}</span>
                  <label className="sr-only" htmlFor="trusted-contact-select">Trusted contact</label>
                  <select
                    id="trusted-contact-select"
                    value={isAddingContact || overview.contacts.length === 0 ? ADD_CONTACT_OPTION : (selectedTrustedContact?.id ?? "")}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === ADD_CONTACT_OPTION) {
                        setIsAddingContact(true);
                        setMagicLink(null);
                        setOptInLink(null);
                        setOptInInvitation(null);
                        setContactAttestationErrorId(null);
                        setIsEditingContactPhone(false);
                        setContactPhoneFormError(null);
                        setNewContactFormError(null);
                        return;
                      }
                      setIsAddingContact(false);
                      setSelectedTrustedContactId(value);
                      setMagicLink(null);
                      setOptInLink(null);
                      setOptInInvitation(null);
                      setContactAttestationErrorId(null);
                      setIsEditingContactPhone(false);
                      setContactPhoneFormError(null);
                    }}
                  >
                    {overview.contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.displayName}</option>)}
                    <option value={ADD_CONTACT_OPTION}>Add a trusted contact…</option>
                  </select>
                  {!isAddingContact && selectedTrustedContact && (
                    <button
                      className="remove-contact-button"
                      type="button"
                      disabled={isRemovingContact}
                      onClick={() => void removeSelectedContact()}
                    >
                      {isRemovingContact ? "Removing…" : "Remove contact"}
                    </button>
                  )}
                </div>
                {!isAddingContact && selectedTrustedContact && (
                <ul className="contact-list">
                  <li key={selectedTrustedContact.id}>
                    <div className="contact-details">
                      <strong>{selectedTrustedContact.displayName}</strong>
                      <span className="contact-relationship">{selectedTrustedContact.relationship}</span>
                      <div className="person-phone-row">
                        <p className="person-phone">{contactPhoneLabel(selectedTrustedContact.phoneE164)}</p>
                        <button
                          className="person-phone-edit"
                          type="button"
                          onClick={() => {
                            setContactPhoneDraft(selectedTrustedContact.phoneE164 ?? "");
                            setContactPhoneFormError(null);
                            setIsEditingContactPhone(true);
                          }}
                        >
                          Edit
                        </button>
                      </div>
                      {isEditingContactPhone && (
                        <form className="phone-editor" onSubmit={saveContactPhone}>
                          <label className="form-field">
                            Phone number
                            <input required placeholder="E.164, e.g. +15551234567" value={contactPhoneDraft} onChange={(event) => {
                              setContactPhoneDraft(event.target.value);
                              setContactPhoneFormError(null);
                            }} />
                            {contactPhoneFormError && <p className="form-validation-error" role="alert">{contactPhoneFormError}</p>}
                          </label>
                          <div className="phone-editor-actions">
                            <button className="secondary-button" type="submit" disabled={isSavingContactPhone}>{isSavingContactPhone ? "Saving…" : "Save"}</button>
                            <button className="secondary-button" type="button" disabled={isSavingContactPhone} onClick={() => {
                              setContactPhoneFormError(null);
                              setIsEditingContactPhone(false);
                            }}>Cancel</button>
                          </div>
                        </form>
                      )}
                      <ul className="contact-status-list">
                        <li>
                          <span>SMS</span>
                          <span className={`contact-status-pill${selectedTrustedContact.smsOptInStatus === "opted_in" ? "" : " is-off"}`}>
                            {selectedTrustedContact.smsOptInStatus === "opted_in" ? "Opted in" : selectedTrustedContact.smsOptInStatus === "opted_out" ? "Opted out" : "Not opted in"}
                          </span>
                        </li>
                        <li>
                          <span>Dashboard link</span>
                          <span className={`contact-status-pill${selectedTrustedContact.dashboardGrant ? "" : " is-off"}`}>
                            {selectedTrustedContact.dashboardGrant ? "Active" : "Not created"}
                          </span>
                        </li>
                        <li>
                          <span>SMS opt-in link</span>
                          <span className={`contact-status-pill${selectedTrustedContact.optInLinkState === "none" ? " is-off" : ""}`}>
                            {selectedTrustedContact.optInLinkState === "none" ? "Not created" : selectedTrustedContact.optInLinkState.replaceAll("_", " ")}
                          </span>
                        </li>
                        <li>
                          <span>SMS confirmation</span>
                          <span className={`contact-status-pill${selectedTrustedContact.confirmationState === "not_requested" ? " is-off" : ""}`}>
                            {selectedTrustedContact.confirmationState === "not_requested" ? "Not requested" : selectedTrustedContact.confirmationState.replaceAll("_", " ")}
                          </span>
                        </li>
                      </ul>
                    </div>
                    <div className="contact-actions">
                        <label className="contact-attestation">
                          <input
                            className="consent-toggle"
                            type="checkbox"
                            checked={attestedContactIds[selectedTrustedContact.id] === true}
                            onChange={(event) => {
                              setAttestedContactIds((current) => ({ ...current, [selectedTrustedContact.id]: event.target.checked }));
                              if (event.target.checked) setContactAttestationErrorId(null);
                            }}
                          />
                          <span>I have permission to invite {selectedTrustedContact.displayName} to receive Iris text messages.</span>
                        </label>
                        {contactAttestationErrorId === selectedTrustedContact.id && (
                          <p className="contact-attestation-error" role="alert">
                            Confirm that you have permission to invite {selectedTrustedContact.displayName} before creating an SMS opt-in link.
                          </p>
                        )}
                        <button
                          className="secondary-button full-width-action"
                          type="button"
                          onClick={() => void createMagicLink(selectedTrustedContact.id)}
                        >
                          {selectedTrustedContact.dashboardGrant ? "Create new dashboard link" : "Create dashboard link"}
                        </button>
                        <button
                          className="secondary-button full-width-action"
                          type="button"
                          onClick={() => {
                            if (!attestedContactIds[selectedTrustedContact.id]) {
                              setContactAttestationErrorId(selectedTrustedContact.id);
                              return;
                            }
                            setContactAttestationErrorId(null);
                            void createOptInLink(selectedTrustedContact.id);
                          }}
                        >
                          Create SMS opt-in link
                        </button>
                      </div>
                  </li>
                </ul>
                )}
            {!isAddingContact && (selectedTrustedContact?.dashboardGrant || magicLink) && (
              <div className="compact-form magic-link" aria-live="polite">
                <strong>Dashboard link</strong>
                {magicLink ? (
                  <>
                    <p className="privacy-note">This link is only viewable once. Please copy and send it to the trusted contact before leaving this page.</p>
                    <div className="link-field">
                      <input readOnly value={magicLink} aria-label="New trusted contact link" />
                    </div>
                    <button className="person-phone-edit link-copy-button" type="button" onClick={() => void copyLink(magicLink, "dashboard")}>
                      {copiedLink === "dashboard" ? "Copied" : "Copy"}
                    </button>
                  </>
                ) : (
                  <p className="privacy-note">An active link is still valid, but the URL can’t be shown again. Create a new link if you need another copy.</p>
                )}
                {selectedTrustedContact?.dashboardGrant ? (
                  <div className="magic-link-meta">
                    <span>Created {formatDate(selectedTrustedContact.dashboardGrant.createdAt)}.</span>
                    <span>Expires {formatDate(selectedTrustedContact.dashboardGrant.expiresAt)}.</span>
                  </div>
                ) : (
                  <p className="magic-link-meta">Expires in seven days.</p>
                )}
                {selectedTrustedContact?.dashboardGrant && (
                  <button
                    className="secondary-button full-width-action"
                    type="button"
                    onClick={() => void revokeDashboardGrant(selectedTrustedContact.dashboardGrant!.id)}
                  >
                    Revoke dashboard link
                  </button>
                )}
              </div>
            )}
            {!isAddingContact && (optInLink || selectedTrustedContact?.smsOptInInvitation) && (
              <div className="compact-form magic-link" aria-live="polite">
                <label className="form-field" htmlFor="sms-opt-in-link">SMS opt-in link</label>
                {optInLink ? (
                  <>
                    <p className="privacy-note">Share within 24 hours. The contact must separately agree before Iris can send SMS. This link is only viewable once. Please copy and send it to the trusted contact before leaving this page.</p>
                    <div className="link-field">
                      <input id="sms-opt-in-link" readOnly value={optInLink} aria-label="Trusted contact SMS opt-in link" />
                    </div>
                    <button className="person-phone-edit link-copy-button" type="button" onClick={() => void copyLink(optInLink, "sms")}>
                      {copiedLink === "sms" ? "Copied" : "Copy"}
                    </button>
                  </>
                ) : (
                  <p className="privacy-note">An active link is still valid, but the URL can’t be shown again. Create a new link if you need another copy.</p>
                )}
                {displayedOptInInvitation && (
                  <div className="magic-link-meta">
                    <span>Created {formatDate(displayedOptInInvitation.createdAt)}.</span>
                    <span>Expires {formatDate(displayedOptInInvitation.expiresAt)}.</span>
                  </div>
                )}
              </div>
            )}
            {isAddingContact && (
              <form className="compact-form" onSubmit={createTrustedContact}>
                <strong>Add a trusted contact</strong>
                <label className="form-field">
                  Name
                  <input required placeholder="e.g. Evelyn Carter" value={contactName} onChange={(event) => {
                    setContactName(event.target.value);
                    if (newContactErrorField === "name") setNewContactFormError(null);
                  }} />
                  {newContactFormError && newContactErrorField === "name" && <p className="form-validation-error" role="alert">{newContactFormError}</p>}
                </label>
                <label className="form-field">
                  Relationship
                  <input required placeholder="e.g. Neighbor" value={contactRelationship} onChange={(event) => {
                    setContactRelationship(event.target.value);
                    if (newContactErrorField === "relationship") setNewContactFormError(null);
                  }} />
                  {newContactFormError && newContactErrorField === "relationship" && <p className="form-validation-error" role="alert">{newContactFormError}</p>}
                </label>
                <label className="form-field">
                  Phone number
                  <input required placeholder="E.164, e.g. +15551234567" value={contactPhone} onChange={(event) => {
                    setContactPhone(event.target.value);
                    if (newContactErrorField === "phone") setNewContactFormError(null);
                  }} />
                  {newContactFormError && newContactErrorField === "phone" && <p className="form-validation-error" role="alert">{newContactFormError}</p>}
                </label>
                <button className="secondary-button create-person-button" type="submit" disabled={isCreatingContact}>{isCreatingContact ? "Saving…" : "Add contact"}</button>
              </form>
            )}
            </section>
            {notesCard}
          </div>
          )}
          {isTrusted && showHomeCards && <div className="trusted-home-notes">{notesCard}</div>}
        </div>
      )}
    </main>
  );
}

type OptInInvitation = {
  personDisplayName: string;
  contactDisplayName: string;
  privacyUrl: string;
  termsUrl: string;
  helpText: string;
};

function OptInPage() {
  const [token] = useState(takeOptInToken);
  const [invitation, setInvitation] = useState<OptInInvitation | null>(null);
  const [phoneE164, setPhoneE164] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "submitting" | "complete" | "unavailable">("loading");
  const [error, setError] = useState<string | null>(null);
  const [phoneFormError, setPhoneFormError] = useState<string | null>(null);
  const [consentFormError, setConsentFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    void publicJson<OptInInvitation>("/api/opt-in/validate", { token })
      .then((result) => {
        if (cancelled) return;
        setInvitation(result);
        setStatus("ready");
      })
      .catch((validationError) => {
        if (cancelled) return;
        setStatus("unavailable");
        setError(validationError instanceof Error ? validationError.message : "This opt-in link is unavailable.");
      });
    return () => { cancelled = true; };
  }, [token]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    const phoneIsValid = E164_PATTERN.test(phoneE164);
    setPhoneFormError(phoneIsValid ? null : "Enter the invited mobile number in E.164 format.");
    setConsentFormError(accepted ? null : "Agree to receive texts before subscribing.");
    if (!phoneIsValid || !accepted) return;
    setStatus("submitting");
    setError(null);
    setConsentFormError(null);
    void publicJson<{ status: "subscribed" }>("/api/opt-in/accept", {
      token,
      phoneE164,
      accepted,
    }).then(() => {
      setStatus("complete");
    }).catch((acceptError) => {
      setStatus("ready");
      const message = acceptError instanceof Error ? acceptError.message : "We could not save your opt-in.";
      if (message === "Enter the invited mobile number in E.164 format.") {
        setPhoneFormError(message);
      } else if (message === "Agree to receive texts before subscribing.") {
        setConsentFormError(message);
      } else {
        setError(message);
      }
    });
  };

  return (
    <main className="access-shell">
      <section className="access-card" aria-labelledby="opt-in-title">
        <p className="eyebrow">Iris companion</p>
        <h1 id="opt-in-title">Care text opt-in</h1>
        {status === "loading" && <p>Checking your invitation…</p>}
        {status === "unavailable" && (
          <p className="form-validation-error" role="alert">{error ?? "This opt-in link is unavailable."}</p>
        )}
        {invitation && status !== "unavailable" && (
          <>
            {status === "complete" ? (
              <p role="status">You’re subscribed to Iris care check-in and Shield alert texts for {invitation.personDisplayName}. A confirmation text is on its way.</p>
            ) : (
              <>
                <p className="access-introduction">
                  You’ve been invited to be a trusted contact for {invitation.personDisplayName}. If you opt in, Iris can send you care check-ins and safety alerts.
                </p>
                <form className="opt-in-form" noValidate onSubmit={submit}>
                  <label className="form-field" htmlFor="opt-in-phone">
                    Confirm your mobile number
                    <span>This is the mobile number the operator entered when adding you as a trusted contact.</span>
                  </label>
                  <input
                    id="opt-in-phone"
                    required
                    inputMode="tel"
                    placeholder="E.164, e.g. +15551234567"
                    value={phoneE164}
                    onChange={(event) => {
                      setPhoneE164(event.target.value);
                      setPhoneFormError(null);
                      setError(null);
                    }}
                  />
                  {phoneFormError && <p className="form-validation-error" role="alert">{phoneFormError}</p>}
                  <label className="consent-check">
                    <input className="consent-toggle" type="checkbox" checked={accepted} onChange={(event) => {
                      setAccepted(event.target.checked);
                      setConsentFormError(null);
                      setError(null);
                    }} />
                    I agree to receive Iris care check-in and Shield alert texts for {invitation.personDisplayName}. Message frequency varies. Msg & data rates may apply. Reply HELP for help. Reply STOP to opt out.
                  </label>
                  {consentFormError && <p className="form-validation-error" role="alert">{consentFormError}</p>}
                  <p className="legal-note">
                    Replying HELP returns: {invitation.helpText}
                  </p>
                  <p className="legal-note">
                    By subscribing, you agree to the <a href={invitation.termsUrl} target="_blank" rel="noreferrer">Terms</a> and acknowledge the <a href={invitation.privacyUrl} target="_blank" rel="noreferrer">Privacy Policy</a>.
                  </p>
                  {error && <p className="form-validation-error" role="alert">{error}</p>}
                  <button type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Saving…" : "Subscribe"}</button>
                </form>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export function App() {
  return window.location.pathname === "/opt-in" ? <OptInPage /> : <DashboardApp />;
}
