import { randomUUID } from "node:crypto";

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
  MemoryCategory,
  Person,
  SmsOptInInvitation,
  TimelineEvent,
  TrustedContact,
  TrustedContactSmsConsent,
  TrustedContactSmsConsentSource,
  TrustedContactSmsOptInStatus,
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
  requested_by_contact_id: string | null;
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
  feature: "bridge" | "shield" | "translator" | "enrollment";
  action_type: string;
  payload_json: string;
  status: ActionStatus;
  approval_source: string | null;
  created_at: string;
  updated_at: string;
};

type TrustedContactSmsConsentRow = {
  id: string;
  trusted_contact_id: string;
  phone_e164: string;
  status: "granted" | "revoked";
  source: TrustedContactSmsConsentSource;
  disclosure_version: string | null;
  occurred_at: string;
};

type SmsOptInInvitationRow = {
  id: string;
  person_id: string;
  trusted_contact_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type SmsOptInInvitationContextRow = SmsOptInInvitationRow & {
  person_display_name: string;
  contact_display_name: string;
  contact_phone_e164: string | null;
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
  requestedByContactId: row.requested_by_contact_id,
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

const toTrustedContactSmsConsent = (
  row: TrustedContactSmsConsentRow,
): TrustedContactSmsConsent => ({
  id: row.id,
  trustedContactId: row.trusted_contact_id,
  phoneE164: row.phone_e164,
  status: row.status,
  source: row.source,
  disclosureVersion: row.disclosure_version,
  occurredAt: row.occurred_at,
});

const toSmsOptInInvitation = (row: SmsOptInInvitationRow): SmsOptInInvitation => ({
  id: row.id,
  personId: row.person_id,
  trustedContactId: row.trusted_contact_id,
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  createdAt: row.created_at,
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

    listPeople() {
      const rows = database
        .prepare("SELECT * FROM people ORDER BY display_name")
        .all() as PersonRow[];
      return rows.map(toPerson);
    },

    deletePerson(id: string) {
      return database.prepare("DELETE FROM people WHERE id = ?").run(id).changes === 1;
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

    recordTrustedContactSmsConsent(input: {
      id: string;
      trustedContactId: string;
      phoneE164: string;
      status: "granted" | "revoked";
      source: TrustedContactSmsConsentSource;
      disclosureVersion?: string | null;
    }) {
      const occurredAt = now();
      database.prepare(
        `INSERT INTO trusted_contact_sms_consents
           (id, trusted_contact_id, phone_e164, status, source, disclosure_version, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.trustedContactId,
        input.phoneE164,
        input.status,
        input.source,
        input.disclosureVersion ?? null,
        occurredAt,
      );
      return toTrustedContactSmsConsent(
        database.prepare("SELECT * FROM trusted_contact_sms_consents WHERE id = ?")
          .get(input.id) as TrustedContactSmsConsentRow,
      );
    },

    listTrustedContactSmsConsents(trustedContactId: string) {
      const rows = database.prepare(
        `SELECT * FROM trusted_contact_sms_consents
         WHERE trusted_contact_id = ?
         ORDER BY occurred_at DESC, rowid DESC`,
      ).all(trustedContactId) as TrustedContactSmsConsentRow[];
      return rows.map(toTrustedContactSmsConsent);
    },

    getTrustedContactSmsOptInStatus(trustedContactId: string): TrustedContactSmsOptInStatus {
      const row = database.prepare(
        `SELECT status FROM trusted_contact_sms_consents
         WHERE trusted_contact_id = ?
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT 1`,
      ).get(trustedContactId) as { status: "granted" | "revoked" } | undefined;
      return row?.status ?? null;
    },

    isTrustedContactSmsEligible(trustedContactId: string) {
      const row = database.prepare(
        `SELECT latest.status, latest.phone_e164 AS consent_phone_e164, c.phone_e164 AS contact_phone_e164
           FROM trusted_contacts c
           LEFT JOIN trusted_contact_sms_consents latest
             ON latest.id = (
               SELECT id FROM trusted_contact_sms_consents
                WHERE trusted_contact_id = c.id
                ORDER BY occurred_at DESC, rowid DESC
                LIMIT 1
             )
          WHERE c.id = ?`,
      ).get(trustedContactId) as {
        status: "granted" | "revoked" | null;
        consent_phone_e164: string | null;
        contact_phone_e164: string | null;
      } | undefined;
      return row?.status === "granted"
        && !!row.contact_phone_e164
        && row.consent_phone_e164 === row.contact_phone_e164;
    },

    getSmsEligibleTrustedContact(input: { id: string; personId: string }) {
      const contact = this.getTrustedContact(input.id);
      return contact
        && contact.personId === input.personId
        && this.isTrustedContactSmsEligible(contact.id)
        ? contact
        : null;
    },

    listSmsEligibleTrustedContacts(personId: string) {
      return this.listTrustedContacts(personId)
        .filter((contact) => this.isTrustedContactSmsEligible(contact.id));
    },

    revokeTrustedContactSmsOptInsByPhone(phoneE164: string) {
      return database.transaction(() => {
        const contacts = database.prepare(
          "SELECT id FROM trusted_contacts WHERE phone_e164 = ?",
        ).all(phoneE164) as Array<{ id: string }>;
        for (const contact of contacts) {
          this.recordTrustedContactSmsConsent({
            id: randomUUID(),
            trustedContactId: contact.id,
            phoneE164,
            status: "revoked",
            source: "inbound_stop",
          });
        }
        return contacts.length;
      })();
    },

    getTrustedContactSmsEnrollmentState(trustedContactId: string, at = now()) {
      const invitations = database.prepare(
        `SELECT * FROM sms_opt_in_invitations
         WHERE trusted_contact_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      ).all(trustedContactId) as SmsOptInInvitationRow[];
      const active = invitations.some((invitation) => !invitation.consumed_at && invitation.expires_at > at);
      const latest = invitations[0];
      const linkState = active
        ? "active"
        : !latest
          ? "none"
          : latest.consumed_at
            ? "used"
            : "expired";
      // A new unconsumed invite must not hide the delivery/recovery outcome of
      // an earlier successful enrollment. Link state and confirmation state are
      // intentionally derived from different invitation rows.
      const latestConsumed = invitations.find((invitation) => invitation.consumed_at);
      if (!latestConsumed) {
        return { optInLinkState: linkState, confirmationState: "not_requested" as const };
      }
      const action = database.prepare(
        "SELECT * FROM action_requests WHERE idempotency_key = ?",
      ).get(`sms_opt_in_confirmation:${latestConsumed.id}`) as ActionRequestRow | undefined;
      if (!action) return { optInLinkState: linkState, confirmationState: "not_requested" as const };
      const dispatch = this.getActionDispatch(action.id);
      const confirmationState = action.status === "dispatched"
        ? "sent"
        : dispatch?.state === "needs_review"
          ? "needs_review"
          : action.status === "failed" || dispatch?.state === "failed"
            ? "failed"
            : dispatch?.state === "retryable"
              ? "retryable"
              : "queued";
      return { optInLinkState: linkState, confirmationState };
    },

    findLatestActiveSmsOptInInvitation(trustedContactId: string, at = now()) {
      const row = database.prepare(
        `SELECT * FROM sms_opt_in_invitations
         WHERE trusted_contact_id = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      ).get(trustedContactId, at) as SmsOptInInvitationRow | undefined;
      return row ? toSmsOptInInvitation(row) : null;
    },

    createSmsOptInInvitation(input: {
      id: string;
      personId: string;
      trustedContactId: string;
      tokenHash: string;
      expiresAt: string;
    }) {
      const createdAt = now();
      const inserted = database.prepare(
        `INSERT INTO sms_opt_in_invitations
           (id, person_id, trusted_contact_id, token_hash, expires_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM trusted_contacts
           WHERE id = ? AND person_id = ?
         )`,
      ).run(
        input.id,
        input.personId,
        input.trustedContactId,
        input.tokenHash,
        input.expiresAt,
        createdAt,
        input.trustedContactId,
        input.personId,
      );
      if (inserted.changes !== 1) {
        throw new Error("Trusted contact does not belong to this person.");
      }
      return toSmsOptInInvitation(
        database.prepare("SELECT * FROM sms_opt_in_invitations WHERE id = ?")
          .get(input.id) as SmsOptInInvitationRow,
      );
    },

    findActiveSmsOptInInvitation(tokenHash: string, at = now()) {
      const row = database.prepare(
        `SELECT * FROM sms_opt_in_invitations
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      ).get(tokenHash, at) as SmsOptInInvitationRow | undefined;
      return row ? toSmsOptInInvitation(row) : null;
    },

    consumeSmsOptInInvitation(id: string) {
      const timestamp = now();
      return database.prepare(
        "UPDATE sms_opt_in_invitations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
      ).run(timestamp, id, timestamp).changes === 1;
    },

    getActiveSmsOptInInvitationContext(tokenHash: string, at = now()) {
      const row = database.prepare(
        `SELECT i.*, p.display_name AS person_display_name,
                c.display_name AS contact_display_name, c.phone_e164 AS contact_phone_e164
           FROM sms_opt_in_invitations i
           JOIN people p ON p.id = i.person_id
           JOIN trusted_contacts c ON c.id = i.trusted_contact_id AND c.person_id = i.person_id
          WHERE i.token_hash = ? AND i.consumed_at IS NULL AND i.expires_at > ?`,
      ).get(tokenHash, at) as SmsOptInInvitationContextRow | undefined;
      return row
        ? {
            invitation: toSmsOptInInvitation(row),
            personDisplayName: row.person_display_name,
            contactDisplayName: row.contact_display_name,
            contactPhoneE164: row.contact_phone_e164,
          }
        : null;
    },

    finalizeSmsOptInEnrollment(input: {
      tokenHash: string;
      phoneE164: string;
      consentId: string;
      actionId: string;
      confirmationBody: string;
      disclosureVersion: string;
    }) {
      return database.transaction(() => {
        const context = this.getActiveSmsOptInInvitationContext(input.tokenHash);
        if (!context || context.contactPhoneE164 !== input.phoneE164) return null;
        const timestamp = now();
        const consumed = database.prepare(
          `UPDATE sms_opt_in_invitations
              SET consumed_at = ?
            WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
        ).run(timestamp, context.invitation.id, timestamp);
        if (consumed.changes !== 1) return null;

        database.prepare(
          `INSERT INTO trusted_contact_sms_consents
             (id, trusted_contact_id, phone_e164, status, source, disclosure_version, occurred_at)
           VALUES (?, ?, ?, 'granted', 'web_form', ?, ?)`,
        ).run(
          input.consentId,
          context.invitation.trustedContactId,
          input.phoneE164,
          input.disclosureVersion,
          timestamp,
        );
        database.prepare(
          `INSERT INTO action_requests
             (id, person_id, feature, action_type, payload_json, status, approval_source, idempotency_key, created_at, updated_at)
           VALUES (?, ?, 'enrollment', 'sms_confirmation', ?, 'approved', 'web_form', ?, ?, ?)`,
        ).run(
          input.actionId,
          context.invitation.personId,
          JSON.stringify({ to: input.phoneE164, body: input.confirmationBody }),
          `sms_opt_in_confirmation:${context.invitation.id}`,
          timestamp,
          timestamp,
        );
        database.prepare(
          `INSERT INTO action_dispatch_outbox
             (action_request_id, state, created_at, updated_at)
           VALUES (?, 'pending', ?, ?)`,
        ).run(input.actionId, timestamp, timestamp);
        return {
          actionId: input.actionId,
          personDisplayName: context.personDisplayName,
          contactDisplayName: context.contactDisplayName,
        };
      })();
    },

    recordOperatorSmsInviteAttestation(input: {
      id: string;
      personId: string;
      trustedContactId: string;
    }) {
      database.prepare(
        `INSERT INTO audit_events
           (id, person_id, actor_type, actor_id, action, target_type, target_id, metadata_json, occurred_at)
         VALUES (?, ?, 'operator', NULL, 'trusted_contact.sms_invite_authorized', 'trusted_contact', ?, '{}', ?)`,
      ).run(input.id, input.personId, input.trustedContactId, now());
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

    getGrant(id: string) {
      const row = database
        .prepare("SELECT * FROM access_grants WHERE id = ?")
        .get(id) as GrantRow | undefined;
      return row ? toGrant(row) : null;
    },

    findLatestActiveGrantForTrustedContact(trustedContactId: string, at = now()) {
      const row = database
        .prepare(
          `SELECT * FROM access_grants
           WHERE trusted_contact_id = ? AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(trustedContactId, at) as GrantRow | undefined;
      return row ? toGrant(row) : null;
    },

    revokeActiveGrantsForTrustedContact(trustedContactId: string, at = now()) {
      database
        .prepare(
          `UPDATE access_grants
           SET revoked_at = ?
           WHERE trusted_contact_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .run(now(), trustedContactId, at);
    },

    revokeGrant(id: string) {
      const result = database
        .prepare(
          "UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now(), id);
      return result.changes === 1;
    },

    recordConsent(input: {
      id: string;
      personId: string;
      kind: ConsentKind;
      status: ConsentStatus;
      source: string;
      operatorAttestationAuditId?: string;
    }) {
      const record = () => {
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
        if (input.operatorAttestationAuditId) {
          database.prepare(
            `INSERT INTO audit_events
               (id, person_id, actor_type, actor_id, action, target_type, target_id, metadata_json, occurred_at)
             VALUES (?, ?, 'operator', NULL, 'person.consent_attested', 'person', ?, ?, ?)`,
          ).run(
            input.operatorAttestationAuditId,
            input.personId,
            input.personId,
            JSON.stringify({ kind: input.kind, status: input.status }),
            timestamp,
          );
        }
      };
      if (input.operatorAttestationAuditId) database.transaction(record)();
      else record();
    },

    /**
     * Care-summary sharing is a second, stricter consent. Revocation removes
     * only the dashboard-only field; narrow memory remains under its separate
     * summary-retention consent.
     */
    recordCareSummarySharingConsent(input: {
      id: string;
      personId: string;
      status: ConsentStatus;
      source: string;
      operatorAttestationAuditId?: string;
    }) {
      if (input.status === "granted" && !this.hasActiveConsent(input.personId, "summary_retention")) {
        return false;
      }

      database.transaction(() => {
        const timestamp = now();
        database
          .prepare(
            `INSERT INTO consents
               (id, person_id, kind, status, source, granted_at, revoked_at)
             VALUES (?, ?, 'care_summary_sharing', ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.personId,
            input.status,
            input.source,
            timestamp,
            input.status === "revoked" ? timestamp : null,
          );

        if (input.operatorAttestationAuditId) {
          database.prepare(
            `INSERT INTO audit_events
               (id, person_id, actor_type, actor_id, action, target_type, target_id, metadata_json, occurred_at)
             VALUES (?, ?, 'operator', NULL, 'person.consent_attested', 'person', ?, ?, ?)`,
          ).run(
            input.operatorAttestationAuditId,
            input.personId,
            input.personId,
            JSON.stringify({ kind: "care_summary_sharing", status: input.status }),
            timestamp,
          );
        }

        if (input.status !== "revoked") return;

        const calls = database.prepare(
          "SELECT id, summary_json FROM calls WHERE person_id = ? AND summary_json IS NOT NULL",
        ).all(input.personId) as Array<{ id: string; summary_json: string }>;
        const update = database.prepare("UPDATE calls SET summary_json = ? WHERE id = ?");
        for (const call of calls) {
          try {
            const parsed = JSON.parse(call.summary_json) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("careSummary" in parsed)) continue;
            const { careSummary: _careSummary, ...privateSummary } = parsed as Record<string, unknown>;
            update.run(JSON.stringify(privateSummary), call.id);
          } catch {
            // Malformed historical JSON cannot contain a safely addressable
            // top-level field, so leave it unchanged rather than corrupt it.
          }
        }
      })();
      return true;
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
      requestedByContactId?: string | null;
    }) {
      const startedAt = now();
      database
        .prepare(
          `INSERT INTO calls (id, person_id, provider_call_id, status, started_at, requested_by_contact_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.personId,
          input.providerCallId ?? null,
          input.status,
          startedAt,
          input.requestedByContactId ?? null,
        );
      const row = database
        .prepare("SELECT * FROM calls WHERE id = ?")
        .get(input.id) as CallRow;
      return toCall(row);
    },

    reserveOutboundCall(input: { id: string; personId: string; requestedByContactId?: string | null }) {
      const requestedByContactId = input.requestedByContactId ?? null;
      return database.transaction(() => {
        const active = database
          .prepare(
            `SELECT * FROM calls
             WHERE person_id = ? AND status IN ('attempted', 'answered')
             ORDER BY started_at DESC
             LIMIT 1`,
          )
          .get(input.personId) as CallRow | undefined;
        if (active) {
          // Only treat the reservation as idempotent when the same requester
          // (admin => null, or the same trusted contact) is asking again.
          // A different requester must not silently inherit an in-flight call.
          if (active.requested_by_contact_id === requestedByContactId) {
            return { call: toCall(active), created: false as const, conflict: false as const };
          }
          return { call: toCall(active), created: false as const, conflict: true as const };
        }
        const call = this.createCall({
          id: input.id,
          personId: input.personId,
          status: "attempted",
          requestedByContactId,
        });
        return { call, created: true as const, conflict: false as const };
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

    findActiveCall(personId: string) {
      const row = database
        .prepare(
          `SELECT * FROM calls
           WHERE person_id = ? AND status IN ('attempted', 'answered')
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get(personId) as CallRow | undefined;
      return row ? toCall(row) : null;
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
      return database
        .prepare("UPDATE calls SET summary_json = ?, summary_state = 'ready' WHERE id = ?")
        .run(input.summaryJson, input.id).changes === 1;
    },

    /**
     * Atomically persist a validated summary, its memories, and the ready event.
     * Any failure rolls back so the call cannot appear ready with partial memory.
     */
    finalizeCallSummary(input: {
      callId: string;
      personId: string;
      summaryJson: string;
      readyEventId: string;
      memories: Array<{ id: string; category: MemoryCategory; payload: unknown }>;
    }) {
      return database.transaction(() => {
        if (!this.saveCallSummary({ id: input.callId, summaryJson: input.summaryJson })) return false;
        for (const memory of input.memories) {
          this.createMemory({
            id: memory.id,
            personId: input.personId,
            sourceCallId: input.callId,
            category: memory.category,
            payload: memory.payload,
          });
        }
        this.createEvent({
          id: input.readyEventId,
          personId: input.personId,
          callId: input.callId,
          type: "call.summary_ready",
          payload: {},
        });
        return true;
      })();
    },

    updateCallSummaryState(input: { id: string; summaryState: Exclude<CallSummaryState, "ready"> }) {
      // Once a summary is ready it is terminal: never downgrade to unavailable
      // or not_requested after a successful finalize.
      return database
        .prepare(
          "UPDATE calls SET summary_state = ? WHERE id = ? AND summary_state <> 'ready' AND summary_state <> ?",
        )
        .run(input.summaryState, input.id, input.summaryState).changes === 1;
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

    createMemory(input: { id: string; personId: string; sourceCallId: string; category: MemoryCategory; payload: unknown }) {
      database.prepare(
        `INSERT INTO memories (id, person_id, source_call_id, category, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.personId, input.sourceCallId, input.category, JSON.stringify(input.payload), now());
    },

    listMemories(personId: string, limit = 20) {
      // Recall anchors are fetched separately for the call opener. Excluding
      // them here keeps the limit window available for durable Bridge context.
      return database.prepare(
        `SELECT category, payload_json FROM memories
         WHERE person_id = ? AND category <> 'recall_anchor'
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(personId, limit) as Array<{ category: string; payload_json: string }>;
    },

    findLatestRecallAnchor(personId: string) {
      const rows = database.prepare(
        `SELECT payload_json FROM memories
         WHERE person_id = ? AND category = 'recall_anchor'
         ORDER BY created_at DESC, rowid DESC`,
      ).all(personId) as Array<{ payload_json: string }>;
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json) as { anchor?: unknown };
          if (typeof payload.anchor !== "string") continue;
          const anchor = payload.anchor.trim();
          if (anchor.length > 0 && anchor.length <= 160) return anchor;
        } catch {
          // A malformed legacy payload is not usable as recall context.
        }
      }
      return null;
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
          "UPDATE action_dispatch_outbox SET state = 'dispatching', updated_at = ? WHERE action_request_id = ? AND state IN ('pending', 'retryable')",
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
      return database.prepare("SELECT state, provider_message_id FROM action_dispatch_outbox WHERE action_request_id = ?").get(actionId) as { state: "pending" | "dispatching" | "dispatched" | "failed" | "retryable" | "needs_review"; provider_message_id: string | null } | undefined;
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
      return database
        .prepare("UPDATE messages SET delivery_status = ? WHERE provider_message_id = ? AND delivery_status <> ?")
        .run(deliveryStatus, providerMessageId, deliveryStatus).changes === 1;
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
        DELETE FROM sms_opt_in_invitations;
        DELETE FROM trusted_contact_sms_consents;
        DELETE FROM access_grants;
        DELETE FROM trusted_contacts;
        DELETE FROM people;
      `);
    },
  };
}

export type IrisRepositories = ReturnType<typeof createRepositories>;
