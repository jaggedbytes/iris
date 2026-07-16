import { resolve } from "node:path";

export type FoundationConfig = {
  databasePath: string;
  demoPersonId: string;
};

export type DashboardConfig = {
  adminToken: string;
  frontendOrigin: string;
};

export type TelephonyConfig = {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  publicBaseUrl: string;
  openaiApiKey: string;
  safetyIdentifier: string;
};

/**
 * Configuration used by the durable foundation. Keeping this separate from
 * process.env makes database commands and tests deterministic.
 */
export function loadFoundationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FoundationConfig {
  const configuredPath = environment.IRIS_DATABASE_PATH?.trim();
  const configuredPersonId = environment.IRIS_DEMO_PERSON_ID?.trim();

  if (configuredPath === "") {
    throw new Error("IRIS_DATABASE_PATH must not be empty.");
  }

  if (configuredPersonId === "") {
    throw new Error("IRIS_DEMO_PERSON_ID must not be empty.");
  }

  return {
    databasePath:
      configuredPath === ":memory:"
        ? configuredPath
        : resolve(configuredPath ?? "data/iris.sqlite"),
    demoPersonId: configuredPersonId ?? "person-demo",
  };
}

export function loadDashboardConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DashboardConfig {
  const adminToken = environment.IRIS_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new Error("IRIS_ADMIN_TOKEN must be configured.");
  }

  return {
    adminToken,
    frontendOrigin: normalizeFrontendOrigin(
      environment.FRONTEND_ORIGIN?.trim() || "http://localhost:5173",
    ),
  };
}

function normalizeFrontendOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FRONTEND_ORIGIN must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("FRONTEND_ORIGIN must use the http or https protocol.");
  }
  return parsed.origin;
}

/** Configuration only needed when the outbound phone transport is enabled. */
export function loadTelephonyConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelephonyConfig {
  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "IRIS_PUBLIC_BASE_URL",
    "OPENAI_API_KEY",
  ] as const;
  const missing = required.filter((key) => !environment[key]?.trim());
  if (missing.length) {
    throw new Error(`${missing.join(", ")} must be configured for phone calls.`);
  }

  const publicBaseUrl = environment.IRIS_PUBLIC_BASE_URL!.trim().replace(/\/$/, "");
  const parsedUrl = new URL(publicBaseUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("IRIS_PUBLIC_BASE_URL must be a publicly reachable https URL.");
  }

  return {
    twilioAccountSid: environment.TWILIO_ACCOUNT_SID!.trim(),
    twilioAuthToken: environment.TWILIO_AUTH_TOKEN!.trim(),
    twilioPhoneNumber: environment.TWILIO_PHONE_NUMBER!.trim(),
    publicBaseUrl,
    openaiApiKey: environment.OPENAI_API_KEY!.trim(),
    safetyIdentifier:
      environment.IRIS_SAFETY_IDENTIFIER?.trim() || "iris-local-prototype",
  };
}
