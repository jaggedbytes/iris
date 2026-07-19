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
  /** Exact HELP auto-response operators must configure on the Messaging Service. */
  helpText: string;
};

export type TelephonyConfig = {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  twilioMessagingServiceSid: string;
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

function normalizeHttpUrl(
  value: string,
  name: string,
  options: { protocols: Set<string>; returnOrigin: boolean },
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      options.returnOrigin
        ? `${name} must be a valid http(s) URL.`
        : `${name} must be a valid https URL.`,
    );
  }
  if (!options.protocols.has(parsed.protocol)) {
    const allowed = [...options.protocols].map((protocol) => protocol.replace(":", "")).join(" or ");
    throw new Error(`${name} must use the ${allowed} protocol.`);
  }
  return options.returnOrigin ? parsed.origin : parsed.toString();
}

function normalizeFrontendOrigin(value: string) {
  return normalizeHttpUrl(value, "FRONTEND_ORIGIN", {
    protocols: new Set(["http:", "https:"]),
    returnOrigin: true,
  });
}

function normalizePublicUrl(value: string, name: string) {
  return normalizeHttpUrl(value, name, {
    protocols: new Set(["https:"]),
    returnOrigin: false,
  });
}

export function loadEnrollmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EnrollmentConfig {
  const disclosureVersion = environment.IRIS_SMS_DISCLOSURE_VERSION?.trim() || "2026-07-18";
  if (disclosureVersion.length > 80) {
    throw new Error("IRIS_SMS_DISCLOSURE_VERSION must be 80 characters or fewer.");
  }
  const helpText = environment.IRIS_SMS_HELP_TEXT?.trim()
    || "Iris support: Reply STOP to opt out of Iris care texts.";
  if (helpText.length > 320) {
    throw new Error("IRIS_SMS_HELP_TEXT must be 320 characters or fewer.");
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
    helpText,
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
    publicBaseUrl,
    openaiApiKey: environment.OPENAI_API_KEY!.trim(),
    safetyIdentifier:
      environment.IRIS_SAFETY_IDENTIFIER?.trim() || "iris-local-prototype",
    farewellCloseTimeoutMs,
  };
}
