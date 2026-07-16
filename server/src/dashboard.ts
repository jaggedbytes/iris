import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { Router, type Request, type Response } from "express";

import type { IrisRepositories } from "./db/repositories.js";
import type { AccessScope } from "./db/types.js";
import type { ActionDispatcher } from "./actions.js";

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
  startOutboundCall?: (personId: string) => Promise<{ callId: string }>;
  actions?: ActionDispatcher;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function safelyMatches(candidate: string, expected: string) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
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

export function createDashboardRouter(context: DashboardContext) {
  const router = Router();

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

    response.json({
      person,
      calls: hasScope(principal, "view_summaries")
        ? context.repositories.listCalls(personId)
        : [],
      events: hasScope(principal, "view_events")
        ? context.repositories.listEvents(personId)
        : [],
      contacts:
        principal.role === "admin"
          ? context.repositories.listTrustedContacts(personId)
          : [],
      actions:
        principal.role === "admin"
          ? context.repositories.listActionRequests(personId)
          : [],
      permissions:
        principal.role === "admin" ? ALL_SCOPES : principal.scopes,
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

  router.post("/people/:personId/calls", async (request, response) => {
    const principal = requirePrincipal(request, response, context);
    if (!principal) return;
    if (principal.role !== "admin") {
      response.status(403).json({ error: "Admin access is required." });
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
      const call = await context.startOutboundCall(request.params.personId);
      response.status(202).json({ ...call, status: "attempted" });
    } catch (error) {
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
