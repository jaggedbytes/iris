import { createHash } from "node:crypto";

/** Hash magic-link and SMS opt-in invitation tokens the same way in every router. */
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
