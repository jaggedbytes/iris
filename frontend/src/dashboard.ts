export type DashboardPrincipal =
  | { role: "admin" }
  | {
      role: "trusted_contact";
      personId: string;
      trustedContact: { displayName: string; relationship: string } | null;
      scopes: string[];
    };

export type DashboardOverview = {
  person: { id: string; displayName: string; phoneE164: string | null };
  calls: Array<{
    id: string;
    status: string;
    startedAt: string;
    summaryJson: string | null;
  }>;
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
  }>;
  permissions: string[];
};

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
    throw new Error(body?.error ?? "Unable to load the Iris dashboard.");
  }
  return (await response.json()) as T;
}
