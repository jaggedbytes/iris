export type AccessScope =
  | "request_check_in"
  | "view_events"
  | "view_summaries";

export type ConsentKind = "summary_retention" | "care_summary_sharing";
export type ConsentStatus = "granted" | "revoked";
export type TrustedContactSmsOptInStatus = "granted" | "revoked" | null;
export type TrustedContactSmsConsentSource = "web_form" | "demo_seed" | "inbound_stop";
export type CallStatus = "attempted" | "answered" | "completed" | "failed";
export type CallSummaryState = "not_requested" | "processing" | "ready" | "unavailable";
export type MemoryCategory =
  | "durable_fact"
  | "named_person"
  | "unresolved_topic"
  | "recall_anchor";
export type ActionStatus =
  | "pending_approval"
  | "approved"
  | "cancelled"
  | "dispatched"
  | "failed";

export type Person = {
  id: string;
  displayName: string;
  phoneE164: string | null;
  createdAt: string;
};

export type TrustedContact = {
  id: string;
  personId: string;
  displayName: string;
  phoneE164: string | null;
  relationship: string;
  createdAt: string;
};

export type TrustedContactSmsConsent = {
  id: string;
  trustedContactId: string;
  phoneE164: string;
  status: Exclude<TrustedContactSmsOptInStatus, null>;
  source: TrustedContactSmsConsentSource;
  disclosureVersion: string | null;
  occurredAt: string;
};

export type SmsOptInInvitation = {
  id: string;
  personId: string;
  trustedContactId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type AccessGrant = {
  id: string;
  personId: string;
  trustedContactId: string;
  scopes: AccessScope[];
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type CallRecord = {
  id: string;
  personId: string;
  providerCallId: string | null;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  summaryJson: string | null;
  summaryState: CallSummaryState;
  requestedByContactId: string | null;
};

export type TimelineEvent = {
  id: string;
  personId: string;
  callId: string | null;
  type: string;
  payload: unknown;
  occurredAt: string;
};

export type ActionRequestRecord = {
  id: string;
  personId: string;
  feature: "bridge" | "shield" | "translator" | "enrollment";
  actionType: string;
  payload: unknown;
  status: ActionStatus;
  approvalSource: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateActionRequest = {
  id: string;
  personId: string;
  feature: "bridge" | "shield" | "translator" | "enrollment";
  actionType: string;
  payload: unknown;
  idempotencyKey: string;
  approvalSource?: string | null;
};
