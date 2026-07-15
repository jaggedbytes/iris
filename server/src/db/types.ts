export type AccessScope =
  | "request_check_in"
  | "view_events"
  | "view_summaries";

export type ConsentKind = "summary_retention";
export type ConsentStatus = "granted" | "revoked";
export type CallStatus = "attempted" | "answered" | "completed" | "failed";
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
};

export type CreateActionRequest = {
  id: string;
  personId: string;
  feature: "bridge" | "shield" | "translator";
  actionType: string;
  payload: unknown;
  idempotencyKey: string;
  approvalSource?: string | null;
};
