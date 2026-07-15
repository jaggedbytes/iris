import { resolve } from "node:path";

export type FoundationConfig = {
  databasePath: string;
  demoPersonId: string;
};

export type DashboardConfig = {
  adminToken: string;
  frontendOrigin: string;
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
    frontendOrigin: environment.FRONTEND_ORIGIN?.trim() || "http://localhost:5173",
  };
}
