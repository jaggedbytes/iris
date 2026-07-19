import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { Router, type Request, type Response } from "express";

import type { IrisRepositories } from "./db/repositories.js";
import type { AccessScope, CallRecord, TimelineEvent } from "./db/types.js";
import type { ActionDispatcher } from "./actions.js";
import { e164Field } from "./phone.js";
import { ActiveCallConflictError, type TrustedCheckInRequester } from "./telephony/outbound.js";
import { hashToken } from "./tokens.js";

const ALL_SCOPES: AccessScope[] = [
  "view_summaries",
  "view_events",
  "request_check_in",
];

type AdminPrincipal = { role: "admin" };
type ContactPrincipal = {
  role: "trusted_contact";
  personId: string;
  trustedContactId: string;
  scopes: AccessScope[];
};
type DashboardPrincipal = AdminPrincipal | ContactPrincipal;

export type DashboardContext = {
  repositories: IrisRepositories;
  adminToken: string;
  frontendOrigin: string;
  demoPersonId: string;
  startOutboundCall?: (input: { personId: string; checkInRequester?: TrustedCheckInRequester }) => Promise<{ callId: string }>;
  actions?: ActionDispatcher;
};

function safelyMatches(candidate: string, expected: string) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function isPeoplePhoneUniqueViolation(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("people.phone_e164")
  );
}

function bearerToken(request: Request) {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function resolvePrincipal(
  request: Request,
  context: DashboardContext,
): DashboardPrincipal | null {
  const token = bearerToken(request);
  if (!token) return null;

  if (safelyMatches(token, context.adminToken)) {
    return { role: "admin" };
  }

  const grant = context.repositories.findActiveGrant(hashToken(token));
  if (!grant) return null;

  return {
    role: "trusted_contact",
    personId: grant.personId,
    trustedContactId: grant.trustedContactId,
    scopes: grant.scopes,
  };
}

function requirePrincipal(
  request: Request,
  response: Response,
  context: DashboardContext,
) {
  const principal = resolvePrincipal(request, context);
  if (!principal) {
    response.status(401).json({ error: "Dashboard access is required." });
    return null;
  }
  return principal;
}

function hasScope(principal: DashboardPrincipal, scope: AccessScope) {
  return principal.role === "admin" || principal.scopes.includes(scope);
}

function canAccessPerson(principal: DashboardPrincipal, personId: string) {
  return principal.role === "admin" || principal.personId === personId;
}

function requestedScopes(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    value.some(
      (scope) =>
        typeof scope !== "string" || !ALL_SCOPES.includes(scope as AccessScope),
    )
  ) {
    return null;
  }

  const scopes = value as AccessScope[];
  return new Set(scopes).size === scopes.length ? scopes : null;
}

function stringField(value: unknown, maxLength = 160) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function objectPayload(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Events are intentionally projected, not passed through. Event payloads are
 * durable implementation data; the timeline is a human-facing privacy
 * boundary and must never inherit new fields by accident.
 */
function timelineEvent(event: TimelineEvent) {
  const source = objectPayload(event.payload);
  let payload: Record<string, string> = {};

  if (event.type === "check_in.requested") {
    const requesterDisplayName = stringField(source.requesterDisplayName);
    payload = requesterDisplayName ? { requesterDisplayName } : {};
  } else if (event.type === "bridge.sms_sent") {
    const contactName = stringField(source.contactName);
    payload = contactName ? { contactName } : {};
  } else if (event.type === "shield.alert_sent") {
    const contactName = stringField(source.contactName);
    payload = contactName ? { contactName } : {};
  } else if (event.type === "sms.delivery_updated") {
    const status = stringField(source.status, 48);
    payload = status ? { status } : {};
  }

  return { id: event.id, type: event.type, payload, occurredAt: event.occurredAt };
}

type SharedCareSummary = {
  recap: string;
  moodAndConcerns: string[];
  irisSuggestedNextSteps: string[];
};

function stringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const values = value.map((item) => stringField(item, maxLength));
  return values.every((item): item is string => !!item) ? values : null;
}

function sharedCareSummary(summaryJson: string | null): SharedCareSummary | null {
  if (!summaryJson) return null;
  try {
    const summary = JSON.parse(summaryJson) as unknown;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const care = (summary as Record<string, unknown>).careSummary;
    if (!care || typeof care !== "object" || Array.isArray(care)) return null;
    const fields = care as Record<string, unknown>;
    const recap = stringField(fields.recap, 500);
    const moodAndConcerns = stringArray(fields.moodAndConcerns, 8, 280);
    const irisSuggestedNextSteps = stringArray(fields.irisSuggestedNextSteps, 8, 280);
    return recap && moodAndConcerns && irisSuggestedNextSteps
      ? { recap, moodAndConcerns, irisSuggestedNextSteps }
      : null;
  } catch {
    return null;
  }
}

function callOverview(call: CallRecord, includeSharedCareSummary: boolean) {
  return {
    id: call.id,
    status: call.status,
    startedAt: call.startedAt,
    // Narrow summary fields are private Iris memory. The care section is
    // separately consented and explicitly projected rather than spreading the
    // storage format into the browser contract.
    careSummary: includeSharedCareSummary ? sharedCareSummary(call.summaryJson) : null,
    summaryState: call.summaryState,
  };
}

export function createDashboardRouter(context: DashboardContext) {
  const router = Router();

  router.get("/people", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }
    response.json({ people: context.repositories.listPeople().map((person) => ({
      id: person.id,
      displayName: person.displayName,
      phoneNumberStatus: person.phoneE164 ? "configured" : "not_configured",
    })) });
  });

  router.post("/people", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }
    const displayName = stringField(request.body?.displayName);
    const rawPhone = request.body?.phoneE164;
    const phoneE164 = rawPhone === undefined || rawPhone === null || rawPhone === ""
      ? null
      : e164Field(rawPhone);
    if (!displayName || (rawPhone && !phoneE164)) {
      response.status(400).json({ error: "A display name and, when supplied, an E.164 phone number are required." });
      return;
    }
    try {
      const person = context.repositories.createPerson({
        id: randomUUID(),
        displayName,
        phoneE164,
      });
      response.status(201).json({ person });
    } catch (error) {
      if (isPeoplePhoneUniqueViolation(error)) {
        response.status(409).json({ error: "That phone number is already assigned." });
        return;
      }
      throw error;
    }
  });

  router.get("/me", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;

    if (principal.role === "admin") {
      response.json({ role: "admin", personId: context.demoPersonId });
      return;
    }

    const contact = context.repositories.getTrustedContact(
      principal.trustedContactId,
    );
    response.json({
      role: "trusted_contact",
      personId: principal.personId,
      trustedContact: contact
        ? { displayName: contact.displayName, relationship: contact.relationship }
        : null,
      scopes: principal.scopes,
    });
  });

  router.get("/people/:personId/overview", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;

    const { personId } = request.params;
    if (!canAccessPerson(principal, personId)) {
      response.status(403).json({ error: "This link cannot access that person." });
      return;
    }

    const person = context.repositories.getPerson(personId);
    if (!person) {
      response.status(404).json({ error: "Person not found." });
      return;
    }

    const activeCall = hasScope(principal, "request_check_in")
      ? context.repositories.findActiveCall(personId)
      : null;
    const careSummarySharingActive = context.repositories.hasActiveConsent(personId, "summary_retention")
      && context.repositories.hasActiveConsent(personId, "care_summary_sharing");

    response.json({
      // The phone number is operator-only PII; trusted contacts receive a
      // scope-appropriate projection regardless of their granted view scopes.
      person:
        principal.role === "admin"
          ? {
              id: person.id,
              displayName: person.displayName,
              phoneE164: person.phoneE164,
              phoneNumberStatus: person.phoneE164 ? "configured" : "not_configured",
            }
          : {
              id: person.id,
              displayName: person.displayName,
              phoneE164: null,
              phoneNumberStatus: "private",
            },
      calls: hasScope(principal, "view_summaries")
        ? context.repositories.listCalls(personId).map((call) => callOverview(call, careSummarySharingActive))
        : [],
      activeCall: activeCall
        ? { id: activeCall.id, status: activeCall.status, startedAt: activeCall.startedAt }
        : null,
      events: hasScope(principal, "view_events")
        ? context.repositories.listEvents(personId).map(timelineEvent)
        : [],
      contacts:
        principal.role === "admin"
          ? context.repositories.listTrustedContacts(personId).map((contact) => {
              const status = context.repositories.getTrustedContactSmsOptInStatus(contact.id);
              const eligible = context.repositories.isTrustedContactSmsEligible(contact.id);
              const enrollment = context.repositories.getTrustedContactSmsEnrollmentState(contact.id);
              return {
                ...contact,
                smsOptInStatus: status === "granted" && eligible
                  ? "opted_in"
                  : status === "revoked"
                    ? "opted_out"
                    : "not_opted_in",
                ...enrollment,
              };
            })
          : [],
      actions:
        principal.role === "admin"
          ? context.repositories.listActionRequests(personId).map((action) => ({
              id: action.id,
              feature: action.feature,
              actionType: action.actionType,
              status: action.status,
              createdAt: action.createdAt,
              updatedAt: action.updatedAt,
              dispatchState: context.repositories.getActionDispatch(action.id)?.state ?? null,
            }))
          : [],
      consents:
        principal.role === "admin"
          ? {
              summaryRetention: context.repositories.hasActiveConsent(personId, "summary_retention"),
              careSummarySharing: context.repositories.hasActiveConsent(personId, "care_summary_sharing"),
            }
          : null,
      permissions:
        principal.role === "admin" ? ALL_SCOPES : principal.scopes,
    });
  });

  router.post("/people/:personId/consents/:kind", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }
    const person = context.repositories.getPerson(request.params.personId);
    if (!person) {
      response.status(404).json({ error: "Person not found." });
      return;
    }
    const kind = request.params.kind;
    if (kind !== "summary_retention" && kind !== "care_summary_sharing") {
      response.status(400).json({ error: "Unsupported consent kind." });
      return;
    }
    const status = request.body?.status;
    if (status !== "granted" && status !== "revoked") {
      response.status(400).json({ error: "Consent status must be granted or revoked." });
      return;
    }
    if (request.body?.operatorAttested !== true) {
      response.status(400).json({ error: "Operator attestation is required." });
      return;
    }

    if (
      kind === "summary_retention"
      && status === "revoked"
      && context.repositories.hasActiveConsent(person.id, "care_summary_sharing")
    ) {
      response.status(409).json({ error: "Revoke care sharing before revoking summary retention." });
      return;
    }

    if (kind === "care_summary_sharing") {
      const recorded = context.repositories.recordCareSummarySharingConsent({
        id: randomUUID(), personId: person.id, status, source: "operator_attestation", operatorAttestationAuditId: randomUUID(),
      });
      if (!recorded) {
        response.status(409).json({ error: "Summary retention must be active before care sharing can be granted." });
        return;
      }
    } else {
      context.repositories.recordConsent({
        id: randomUUID(), personId: person.id, kind, status, source: "operator_attestation", operatorAttestationAuditId: randomUUID(),
      });
    }

    response.status(201).json({
      summaryRetention: context.repositories.hasActiveConsent(person.id, "summary_retention"),
      careSummarySharing: context.repositories.hasActiveConsent(person.id, "care_summary_sharing"),
    });
  });

  router.post("/people/:personId/magic-links", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }

    const { personId } = request.params;
    const trustedContactId =
      typeof request.body?.trustedContactId === "string"
        ? request.body.trustedContactId
        : null;
    if (!trustedContactId) {
      response.status(400).json({ error: "trustedContactId is required." });
      return;
    }

    const contact = context.repositories.getTrustedContact(trustedContactId);
    if (!contact || contact.personId !== personId) {
      response.status(400).json({ error: "Trusted contact does not belong to this person." });
      return;
    }

    const scopes = requestedScopes(request.body?.scopes);
    if (!scopes) {
      response.status(400).json({
        error: "scopes must be a non-empty array of unique supported permissions.",
      });
      return;
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const grant = context.repositories.grantAccess({
      id: randomUUID(),
      personId,
      trustedContactId,
      scopes,
      tokenHash: hashToken(token),
      expiresAt,
    });

    const magicLink = new URL(context.frontendOrigin);
    magicLink.hash = new URLSearchParams({ access: token }).toString();
    response.status(201).json({
      grant: { id: grant.id, expiresAt: grant.expiresAt, scopes: grant.scopes },
      magicLink: magicLink.toString(),
    });
  });

  router.post("/people/:personId/trusted-contacts", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }
    const person = context.repositories.getPerson(request.params.personId);
    if (!person) {
      response.status(404).json({ error: "Person not found." });
      return;
    }
    const displayName = stringField(request.body?.displayName);
    const relationship = stringField(request.body?.relationship);
    const phoneE164 = e164Field(request.body?.phoneE164);
    if (!displayName || !relationship || !phoneE164) {
      response.status(400).json({ error: "Display name, relationship, and an E.164 mobile number are required." });
      return;
    }
    const contact = context.repositories.createTrustedContact({
      id: randomUUID(),
      personId: person.id,
      displayName,
      relationship,
      phoneE164,
    });
    response.status(201).json({ contact, smsOptInStatus: "not_opted_in" });
  });

  router.post("/people/:personId/trusted-contacts/:trustedContactId/opt-in-invitations", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }
    if (request.body?.operatorAttested !== true) {
      response.status(400).json({ error: "Operator attestation is required before inviting a trusted contact." });
      return;
    }
    const person = context.repositories.getPerson(request.params.personId);
    const contact = context.repositories.getTrustedContact(request.params.trustedContactId);
    if (!person || !contact || contact.personId !== person.id || !contact.phoneE164) {
      response.status(404).json({ error: "Trusted contact with a mobile number was not found for this person." });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const invitation = context.repositories.createSmsOptInInvitation({
      id: randomUUID(),
      personId: person.id,
      trustedContactId: contact.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    context.repositories.recordOperatorSmsInviteAttestation({
      id: randomUUID(),
      personId: person.id,
      trustedContactId: contact.id,
    });
    const optInUrl = new URL("/opt-in", context.frontendOrigin);
    optInUrl.searchParams.set("token", token);
    response.status(201).json({
      invitation: { id: invitation.id, expiresAt: invitation.expiresAt },
      optInLink: optInUrl.toString(),
    });
  });

  router.post("/people/:personId/calls", async (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    const { personId } = request.params;
    if (!canAccessPerson(principal, personId) || !hasScope(principal, "request_check_in")) {
      response.status(403).json({ error: "Check-in access is required." });
      return;
    }
    if (!context.repositories.getPerson(request.params.personId)) {
      response.status(404).json({ error: "Person not found." });
      return;
    }
    if (!context.startOutboundCall) {
      response.status(503).json({ error: "Outbound calling is not configured." });
      return;
    }

    try {
      let checkInRequester: TrustedCheckInRequester | undefined;
      if (principal.role === "trusted_contact") {
        const contact = context.repositories.getTrustedContact(principal.trustedContactId);
        if (!contact || contact.personId !== personId) {
          response.status(403).json({ error: "Trusted contact is no longer available for this person." });
          return;
        }
        checkInRequester = { trustedContactId: contact.id, displayName: contact.displayName };
      }
      const call = await context.startOutboundCall({ personId: request.params.personId, checkInRequester });
      response.status(202).json({ ...call, status: "attempted" });
    } catch (error) {
      if (error instanceof ActiveCallConflictError) {
        response.status(409).json({ error: "A call is already in progress for this person." });
        return;
      }
      console.error("Unable to initiate outbound call", error);
      response.status(502).json({ error: "Iris could not place the call." });
    }
  });

  router.post("/actions/:actionId/approve", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin" || !context.actions) return response.status(403).json({ error: "Admin access is required." });
    const action = context.actions.approve(request.params.actionId, "dashboard_admin");
    if (!action) return response.status(409).json({ error: "Action cannot be approved." });
    response.json(action);
  });

  router.post("/actions/:actionId/dispatch", async (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin" || !context.actions) return response.status(403).json({ error: "Admin access is required." });
    try {
      // Privileged path: release a needs_review claim before retrying. Automatic
      // sweeps never re-send; only an admin dispatch may.
      context.actions.releaseForRetry(request.params.actionId);
      const result = await context.actions.dispatchSms(request.params.actionId);
      if (!result) return response.status(409).json({ error: "Action must be approved and undispatched." });
      response.status(202).json(result);
    } catch { response.status(502).json({ error: "Unable to dispatch message." }); }
  });

  router.delete("/access-grants/:grantId", (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
      return;
    }

    context.repositories.revokeGrant(request.params.grantId);
    response.status(204).end();
  });

  return router;
}
