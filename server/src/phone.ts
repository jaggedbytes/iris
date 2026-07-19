/** Shared E.164 validation for admin drafting and public SMS opt-in. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isE164(value: unknown): value is string {
  return typeof value === "string" && E164_PATTERN.test(value);
}

export function e164Field(value: unknown, maxLength = 16) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength && E164_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}
