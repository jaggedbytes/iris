import { resolve } from "node:path";

export type FoundationConfig = {
  databasePath: string;
  demoPersonId: string;
};

export type DashboardConfig = {
  adminToken: string;
  frontendOrigin: string;
};

export type EnrollmentConfig = {
  privacyUrl: string;
  termsUrl: string;
  disclosureVersion: string;
};

export type TelephonyConfig = {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  twilioMessagingServiceSid: string;
  smsHelpText: string;
  publicBaseUrl: string;
  openaiApiKey: string;
  safetyIdentifier: string;
  farewellCloseTimeoutMs: number;
};

export const DEFAULT_FAREWELL_CLOSE_TIMEOUT_MS = 8_000;

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
  const configuredFrontendOrigin = environment.FRONTEND_ORIGIN?.trim();
  if (!adminToken) {
    throw new Error("IRIS_ADMIN_TOKEN must be configured.");
  }
  if (environment.NODE_ENV === "production" && !configuredFrontendOrigin) {
    throw new Error("FRONTEND_ORIGIN must be configured in production.");
  }

  return {
    adminToken,
    frontendOrigin: normalizeFrontendOrigin(
      configuredFrontendOrigin || "http://localhost:5173",
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

function normalizePublicUrl(value: string, name: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid https URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use the https protocol.`);
  }
  return parsed.toString();
}

export function loadEnrollmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EnrollmentConfig {
  const disclosureVersion = environment.IRIS_SMS_DISCLOSURE_VERSION?.trim() || "2026-07-18";
  if (disclosureVersion.length > 80) {
    throw new Error("IRIS_SMS_DISCLOSURE_VERSION must be 80 characters or fewer.");
  }
  return {
    privacyUrl: normalizePublicUrl(
      environment.IRIS_PRIVACY_URL?.trim() || "https://jaggedbytes.github.io/iris-legal/privacy/",
      "IRIS_PRIVACY_URL",
    ),
    termsUrl: normalizePublicUrl(
      environment.IRIS_TERMS_URL?.trim() || "https://jaggedbytes.github.io/iris-legal/terms/",
      "IRIS_TERMS_URL",
    ),
    disclosureVersion,
  };
}

/** Configuration only needed when the outbound phone transport is enabled. */
export function loadTelephonyConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelephonyConfig {
  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_MESSAGING_SERVICE_SID",
    "IRIS_SMS_HELP_TEXT",
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

  const configuredFarewellCloseTimeoutMs = environment.IRIS_FAREWELL_CLOSE_TIMEOUT_MS?.trim();
  const farewellCloseTimeoutMs = configuredFarewellCloseTimeoutMs
    ? Number(configuredFarewellCloseTimeoutMs)
    : DEFAULT_FAREWELL_CLOSE_TIMEOUT_MS;
  if (
    !Number.isInteger(farewellCloseTimeoutMs) ||
    farewellCloseTimeoutMs < 1_000 ||
    farewellCloseTimeoutMs > 30_000
  ) {
    throw new Error("IRIS_FAREWELL_CLOSE_TIMEOUT_MS must be an integer between 1000 and 30000 milliseconds.");
  }

  return {
    twilioAccountSid: environment.TWILIO_ACCOUNT_SID!.trim(),
    twilioAuthToken: environment.TWILIO_AUTH_TOKEN!.trim(),
    twilioPhoneNumber: environment.TWILIO_PHONE_NUMBER!.trim(),
    twilioMessagingServiceSid: environment.TWILIO_MESSAGING_SERVICE_SID!.trim(),
    smsHelpText: environment.IRIS_SMS_HELP_TEXT!.trim(),
    publicBaseUrl,
    openaiApiKey: environment.OPENAI_API_KEY!.trim(),
    safetyIdentifier:
      environment.IRIS_SAFETY_IDENTIFIER?.trim() || "iris-local-prototype",
    farewellCloseTimeoutMs,
  };
}
