import type { IrisDatabase } from "./database.js";
import type {
  AccessGrant,
  AccessScope,
  ActionRequestRecord,
  ActionStatus,
  CallRecord,
  CallSummaryState,
  CallStatus,
  ConsentKind,
  ConsentStatus,
  CreateActionRequest,
  Person,
  TimelineEvent,
  TrustedContact,
} from "./types.js";

type PersonRow = {
  id: string;
  display_name: string;
  phone_e164: string | null;
  created_at: string;
};

type ContactRow = {
  id: string;
  person_id: string;
  display_name: string;
  phone_e164: string | null;
  relationship: string;
  created_at: string;
};

type GrantRow = {
  id: string;
  person_id: string;
  trusted_contact_id: string;
  scopes_json: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

type CallRow = {
  id: string;
  person_id: string;
  provider_call_id: string | null;
  status: CallStatus;
  started_at: string;
  ended_at: string | null;
  summary_json: string | null;
  summary_state: CallSummaryState;
};

type EventRow = {
  id: string;
  person_id: string;
  call_id: string | null;
  type: string;
  payload_json: string;
  occurred_at: string;
};

type ActionRequestRow = {
  id: string;
  person_id: string;
  feature: "bridge" | "shield" | "translator";
  action_type: string;
  payload_json: string;
  status: ActionStatus;
  approval_source: string | null;
  created_at: string;
  updated_at: string;
};

const now = () => new Date().toISOString();

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  displayName: row.display_name,
  phoneE164: row.phone_e164,
  createdAt: row.created_at,
});

const toContact = (row: ContactRow): TrustedContact => ({
  id: row.id,
  personId: row.person_id,
  displayName: row.display_name,
  phoneE164: row.phone_e164,
  relationship: row.relationship,
  createdAt: row.created_at,
});

const toGrant = (row: GrantRow): AccessGrant => ({
  id: row.id,
  personId: row.person_id,
  trustedContactId: row.trusted_contact_id,
  scopes: JSON.parse(row.scopes_json) as AccessScope[],
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

const toCall = (row: CallRow): CallRecord => ({
  id: row.id,
  personId: row.person_id,
  providerCallId: row.provider_call_id,
  status: row.status,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  summaryJson: row.summary_json,
  summaryState: row.summary_state,
});

const toEvent = (row: EventRow): TimelineEvent => ({
  id: row.id,
  personId: row.person_id,
  callId: row.call_id,
  type: row.type,
  payload: JSON.parse(row.payload_json) as unknown,
  occurredAt: row.occurred_at,
});

const toActionRequest = (row: ActionRequestRow): ActionRequestRecord => ({
  id: row.id,
  personId: row.person_id,
  feature: row.feature,
  actionType: row.action_type,
  payload: JSON.parse(row.payload_json) as unknown,
  status: row.status,
  approvalSource: row.approval_source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createRepositories(database: IrisDatabase) {
  return {
    createPerson(input: {
      id: string;
      displayName: string;
      phoneE164?: string | null;
    }) {
      const createdAt = now();
      database
        .prepare(
          `INSERT INTO people (id, display_name, phone_e164, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.id, input.displayName, input.phoneE164 ?? null, createdAt);
      return this.getPerson(input.id)!;
    },

    getPerson(id: string) {
      const row = database
        .prepare("SELECT * FROM people WHERE id = ?")
        .get(id) as PersonRow | undefined;
      return row ? toPerson(row) : null;
    },

    createTrustedContact(input: {
      id: string;
      personId: string;
      displayName: string;
      relationship: string;
      phoneE164?: string | null;
    }) {
      const createdAt = now();
      database
        .prepare(
          `INSERT INTO trusted_contacts
             (id, person_id, display_name, phone_e164, relationship, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.displayName,
          input.phoneE164 ?? null,
          input.relationship,
          createdAt,
        );
      const row = database
        .prepare("SELECT * FROM trusted_contacts WHERE id = ?")
        .get(input.id) as ContactRow;
      return toContact(row);
    },

    getTrustedContact(id: string) {
      const row = database
        .prepare("SELECT * FROM trusted_contacts WHERE id = ?")
        .get(id) as ContactRow | undefined;
      return row ? toContact(row) : null;
    },

    listTrustedContacts(personId: string) {
      const rows = database
        .prepare(
          "SELECT * FROM trusted_contacts WHERE person_id = ? ORDER BY display_name",
        )
        .all(personId) as ContactRow[];
      return rows.map(toContact);
    },

    grantAccess(input: {
      id: string;
      personId: string;
      trustedContactId: string;
      scopes: AccessScope[];
      tokenHash: string;
      expiresAt: string;
    }) {
      const createdAt = now();
      database
        .prepare(
          `INSERT INTO access_grants
             (id, person_id, trusted_contact_id, scopes_json, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.trustedContactId,
          JSON.stringify(input.scopes),
          input.tokenHash,
          input.expiresAt,
          createdAt,
        );
      const row = database
        .prepare("SELECT * FROM access_grants WHERE id = ?")
        .get(input.id) as GrantRow;
      return toGrant(row);
    },

    findActiveGrant(tokenHash: string, at = now()) {
      const row = database
        .prepare(
          `SELECT * FROM access_grants
           WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(tokenHash, at) as GrantRow | undefined;
      return row ? toGrant(row) : null;
    },

    revokeGrant(id: string) {
      database
        .prepare("UPDATE access_grants SET revoked_at = ? WHERE id = ?")
        .run(now(), id);
    },

    recordConsent(input: {
      id: string;
      personId: string;
      kind: ConsentKind;
      status: ConsentStatus;
      source: string;
    }) {
      const timestamp = now();
      database
        .prepare(
          `INSERT INTO consents
             (id, person_id, kind, status, source, granted_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.kind,
          input.status,
          input.source,
          timestamp,
          input.status === "revoked" ? timestamp : null,
        );
    },

    hasActiveConsent(personId: string, kind: ConsentKind) {
      const row = database
        .prepare(
          `SELECT status FROM consents
           WHERE person_id = ? AND kind = ?
           ORDER BY granted_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(personId, kind) as { status: ConsentStatus } | undefined;
      return row?.status === "granted";
    },

    createCall(input: {
      id: string;
      personId: string;
      status: CallStatus;
      providerCallId?: string | null;
    }) {
      const startedAt = now();
      database
        .prepare(
          `INSERT INTO calls (id, person_id, provider_call_id, status, started_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.providerCallId ?? null,
          input.status,
          startedAt,
        );
      const row = database
        .prepare("SELECT * FROM calls WHERE id = ?")
        .get(input.id) as CallRow;
      return toCall(row);
    },

    reserveOutboundCall(input: { id: string; personId: string }) {
      return database.transaction(() => {
        const active = database
          .prepare(
            `SELECT * FROM calls
             WHERE person_id = ? AND status IN ('attempted', 'answered')
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .get(input.personId) as CallRow | undefined;
        if (active) return { call: toCall(active), created: false };
        const call = this.createCall({ id: input.id, personId: input.personId, status: "attempted" });
        return { call, created: true };
      })();
    },

    listActiveCalls() {
      const rows = database
        .prepare(
          "SELECT * FROM calls WHERE status IN ('attempted', 'answered') ORDER BY started_at",
        )
        .all() as CallRow[];
      return rows.map(toCall);
    },

    interruptActiveCall(id: string) {
      return database
        .prepare(
          `UPDATE calls
             SET status = 'failed', ended_at = ?, summary_state = 'unavailable'
           WHERE id = ? AND status IN ('attempted', 'answered')`,
        )
        .run(now(), id).changes === 1;
    },

    completeCall(input: { id: string; status: Extract<CallStatus, "completed" | "failed">; summaryJson?: string | null; summaryState?: CallSummaryState }) {
      const summaryState = input.summaryState ?? (input.summaryJson ? "ready" : input.status === "failed" ? "unavailable" : undefined);
      database
        .prepare(
          `UPDATE calls
             SET status = ?, ended_at = ?, summary_json = COALESCE(?, summary_json),
                 summary_state = COALESCE(?, summary_state)
           WHERE id = ?`,
        )
        .run(input.status, now(), input.summaryJson ?? null, summaryState ?? null, input.id);
    },

    saveCallSummary(input: { id: string; summaryJson: string }) {
      // Summary persistence happens after the call is already completed, so it
      // must not touch ended_at (doing so would inflate the recorded duration).
      database
        .prepare("UPDATE calls SET summary_json = ?, summary_state = 'ready' WHERE id = ?")
        .run(input.summaryJson, input.id);
    },

    updateCallSummaryState(input: { id: string; summaryState: Exclude<CallSummaryState, "ready"> }) {
      database
        .prepare("UPDATE calls SET summary_state = ? WHERE id = ?")
        .run(input.summaryState, input.id);
    },

    updateCall(input: {
      id: string;
      status?: Extract<CallStatus, "attempted" | "answered">;
      providerCallId?: string;
    }) {
      if (input.status) {
        database
          .prepare(
            "UPDATE calls SET status = ?, provider_call_id = COALESCE(?, provider_call_id) WHERE id = ?",
          )
          .run(input.status, input.providerCallId ?? null, input.id);
        return;
      }
      if (input.providerCallId) {
        database
          .prepare("UPDATE calls SET provider_call_id = ? WHERE id = ?")
          .run(input.providerCallId, input.id);
      }
    },

    listCalls(personId: string) {
      const rows = database
        .prepare(
          "SELECT * FROM calls WHERE person_id = ? ORDER BY started_at DESC",
        )
        .all(personId) as CallRow[];
      return rows.map(toCall);
    },

    createMemory(input: { id: string; personId: string; sourceCallId: string; category: string; payload: unknown }) {
      database.prepare(
        `INSERT INTO memories (id, person_id, source_call_id, category, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.personId, input.sourceCallId, input.category, JSON.stringify(input.payload), now());
    },

    listMemories(personId: string, limit = 20) {
      return database.prepare(
        "SELECT category, payload_json FROM memories WHERE person_id = ? ORDER BY created_at DESC LIMIT ?",
      ).all(personId, limit) as Array<{ category: string; payload_json: string }>;
    },

    createEvent(input: {
      id: string;
      personId: string;
      type: string;
      payload: unknown;
      callId?: string | null;
    }) {
      database
        .prepare(
          `INSERT INTO events (id, person_id, call_id, type, payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.callId ?? null,
          input.type,
          JSON.stringify(input.payload),
          now(),
        );
    },

    createAuditEvent(input: { id: string; personId: string; action: string; targetId: string; metadata: unknown }) {
      database.prepare(
        `INSERT INTO audit_events (id, person_id, actor_type, actor_id, action, target_type, target_id, metadata_json, occurred_at)
         VALUES (?, ?, 'system', NULL, ?, 'action_request', ?, ?, ?)`,
      ).run(input.id, input.personId, input.action, input.targetId, JSON.stringify(input.metadata), now());
    },

    createActionRequest(input: CreateActionRequest) {
      const timestamp = now();
      database
        .prepare(
          `INSERT INTO action_requests
             (id, person_id, feature, action_type, payload_json, status, approval_source, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.feature,
          input.actionType,
          JSON.stringify(input.payload),
          input.approvalSource ?? null,
          input.idempotencyKey,
          timestamp,
          timestamp,
        );
    },

    getActionRequest(id: string) {
      const row = database.prepare("SELECT * FROM action_requests WHERE id = ?").get(id) as ActionRequestRow | undefined;
      return row ? toActionRequest(row) : null;
    },

    findActionRequestByIdempotencyKey(idempotencyKey: string) {
      const row = database.prepare("SELECT * FROM action_requests WHERE idempotency_key = ?").get(idempotencyKey) as ActionRequestRow | undefined;
      return row ? toActionRequest(row) : null;
    },

    updateActionRequest(input: { id: string; status: ActionStatus; approvalSource?: string | null; expectedStatus?: ActionStatus }) {
      // When expectedStatus is supplied this is a compare-and-set: the row only
      // transitions if it is still in the expected state, and null is returned
      // when it is not, so racing transitions cannot clobber one another.
      const result = input.expectedStatus
        ? database.prepare(
            "UPDATE action_requests SET status = ?, approval_source = COALESCE(?, approval_source), updated_at = ? WHERE id = ? AND status = ?",
          ).run(input.status, input.approvalSource ?? null, now(), input.id, input.expectedStatus)
        : database.prepare(
            "UPDATE action_requests SET status = ?, approval_source = COALESCE(?, approval_source), updated_at = ? WHERE id = ?",
          ).run(input.status, input.approvalSource ?? null, now(), input.id);
      if (input.expectedStatus && result.changes === 0) return null;
      return this.getActionRequest(input.id);
    },

    claimActionDispatch(actionId: string) {
      return database.transaction(() => {
        const timestamp = now();
        const inserted = database.prepare(
          "INSERT OR IGNORE INTO action_dispatch_outbox (action_request_id, state, created_at, updated_at) VALUES (?, 'dispatching', ?, ?)",
        ).run(actionId, timestamp, timestamp);
        if (inserted.changes === 1) return true;
        return database.prepare(
          "UPDATE action_dispatch_outbox SET state = 'dispatching', updated_at = ? WHERE action_request_id = ? AND state = 'retryable'",
        ).run(timestamp, actionId).changes === 1;
      })();
    },

    completeActionDispatch(input: { actionId: string; providerMessageId: string }) {
      database.prepare(
        "UPDATE action_dispatch_outbox SET state = 'dispatched', provider_message_id = ?, updated_at = ? WHERE action_request_id = ?",
      ).run(input.providerMessageId, now(), input.actionId);
    },

    failActionDispatch(actionId: string) {
      database.prepare(
        "UPDATE action_dispatch_outbox SET state = 'failed', updated_at = ? WHERE action_request_id = ? AND state = 'dispatching'",
      ).run(now(), actionId);
    },

    retryActionDispatch(actionId: string) {
      database.prepare(
        "UPDATE action_dispatch_outbox SET state = 'retryable', updated_at = ? WHERE action_request_id = ? AND state = 'dispatching'",
      ).run(now(), actionId);
    },

    reclaimStaleDispatches(cutoffIso: string) {
      // Promote to needs_review (not retryable): a stale dispatching claim may
      // still have been accepted by Twilio, so automatic re-send is unsafe.
      return database.transaction(() => {
        const rows = database.prepare(
          `SELECT o.action_request_id AS actionRequestId, a.person_id AS personId
             FROM action_dispatch_outbox o
             JOIN action_requests a ON a.id = o.action_request_id
            WHERE o.state = 'dispatching' AND o.updated_at < ? AND a.status = 'approved'`,
        ).all(cutoffIso) as Array<{ actionRequestId: string; personId: string }>;
        const promote = database.prepare(
          "UPDATE action_dispatch_outbox SET state = 'needs_review', updated_at = ? WHERE action_request_id = ? AND state = 'dispatching'",
        );
        const timestamp = now();
        for (const row of rows) promote.run(timestamp, row.actionRequestId);
        return rows;
      })();
    },

    releaseDispatchForRetry(actionId: string) {
      return database.prepare(
        "UPDATE action_dispatch_outbox SET state = 'retryable', updated_at = ? WHERE action_request_id = ? AND state = 'needs_review'",
      ).run(now(), actionId).changes === 1;
    },

    getActionDispatch(actionId: string) {
      return database.prepare("SELECT state, provider_message_id FROM action_dispatch_outbox WHERE action_request_id = ?").get(actionId) as { state: "dispatching" | "dispatched" | "failed" | "retryable" | "needs_review"; provider_message_id: string | null } | undefined;
    },

    finalizeActionDispatch(input: { id: string; personId: string; actionRequestId: string; providerMessageId: string; deliveryStatus: string }) {
      return database.transaction(() => {
        const dispatch = this.getActionDispatch(input.actionRequestId);
        // Late Twilio callbacks may arrive after a stale claim was parked for review.
        if (dispatch?.state !== "dispatching" && dispatch?.state !== "needs_review") return false;
        // CAS first so a concurrent status change aborts before any message or
        // outbox write is committed, keeping the three tables consistent.
        const updated = this.updateActionRequest({
          id: input.actionRequestId,
          status: "dispatched",
          expectedStatus: "approved",
        });
        if (!updated) return false;
        database.prepare(
          `INSERT OR IGNORE INTO messages (id, person_id, action_request_id, direction, provider_message_id, delivery_status, created_at)
           VALUES (?, ?, ?, 'outbound', ?, ?, ?)`,
        ).run(input.id, input.personId, input.actionRequestId, input.providerMessageId, input.deliveryStatus, now());
        this.completeActionDispatch({ actionId: input.actionRequestId, providerMessageId: input.providerMessageId });
        return true;
      })();
    },

    createMessage(input: { id: string; personId: string; actionRequestId: string; providerMessageId: string; deliveryStatus: string }) {
      database.prepare(
        `INSERT INTO messages (id, person_id, action_request_id, direction, provider_message_id, delivery_status, created_at)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?)`,
      ).run(input.id, input.personId, input.actionRequestId, input.providerMessageId, input.deliveryStatus, now());
    },

    updateMessageDelivery(providerMessageId: string, deliveryStatus: string) {
      database.prepare("UPDATE messages SET delivery_status = ? WHERE provider_message_id = ?").run(deliveryStatus, providerMessageId);
    },

    listEvents(personId: string) {
      const rows = database
        .prepare(
          "SELECT * FROM events WHERE person_id = ? ORDER BY occurred_at DESC",
        )
        .all(personId) as EventRow[];
      return rows.map(toEvent);
    },

    listActionRequests(personId: string) {
      const rows = database
        .prepare(
          "SELECT * FROM action_requests WHERE person_id = ? ORDER BY created_at DESC",
        )
        .all(personId) as ActionRequestRow[];
      return rows.map(toActionRequest);
    },

    resetAll() {
      database.exec(`
        DELETE FROM audit_events;
        DELETE FROM messages;
        DELETE FROM action_requests;
        DELETE FROM events;
        DELETE FROM memories;
        DELETE FROM documents;
        DELETE FROM calls;
        DELETE FROM consents;
        DELETE FROM access_grants;
        DELETE FROM trusted_contacts;
        DELETE FROM people;
      `);
    },
  };
}

export type IrisRepositories = ReturnType<typeof createRepositories>;
