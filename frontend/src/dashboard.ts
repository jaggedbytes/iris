export type DashboardPrincipal =
  | { role: "admin"; personId: string }
  | {
      role: "trusted_contact";
      personId: string;
      trustedContact: { displayName: string; relationship: string } | null;
      scopes: string[];
    };

export type DashboardOverview = {
  person: {
    id: string;
    displayName: string;
    phoneE164: string | null;
    phoneNumberStatus: "configured" | "not_configured" | "private";
  };
  calls: Array<{
    id: string;
    status: string;
    startedAt: string;
    summaryRecap: string | null;
    summaryState: "not_requested" | "processing" | "ready" | "unavailable";
  }>;
  activeCall: { id: string; status: "attempted" | "answered"; startedAt: string } | null;
  events: Array<{
    id: string;
    type: string;
    payload: unknown;
    occurredAt: string;
  }>;
  contacts: Array<{
    id: string;
    displayName: string;
    relationship: string;
    phoneE164: string | null;
  }>;
  actions: Array<{
    id: string;
    feature: string;
    actionType: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    dispatchState: "dispatching" | "dispatched" | "failed" | "retryable" | "needs_review" | null;
  }>;
  permissions: string[];
};

export class DashboardError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DashboardError";
    this.status = status;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export function dashboardRequest(path: string, token: string, options?: RequestInit) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });
}

export async function dashboardJson<T>(path: string, token: string, options?: RequestInit) {
  const response = await dashboardRequest(path, token, options);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new DashboardError(
      body?.error ?? "Unable to load the Iris dashboard.",
      response.status,
    );
  }
  return (await response.json()) as T;
}
