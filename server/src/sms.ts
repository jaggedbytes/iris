export const SMS_PREFIX = "Iris:";
export const SMS_FOOTER = "Reply HELP for help. Reply STOP to opt out.";
export const MAX_SMS_LENGTH = 480;

function normalizedContent(value: string) {
  return value
    .trim()
    .replace(/^Iris:\s*/i, "")
    .replace(/\s*Reply HELP for help\. Reply STOP to opt out\.\s*$/i, "")
    .trim();
}

export const MAX_SMS_CONTENT_LENGTH = MAX_SMS_LENGTH - `${SMS_PREFIX}  ${SMS_FOOTER}`.length;

/** Formats the only production SMS shape: one Iris prefix and one footer. */
export function formatIrisSms(content: string) {
  const clean = normalizedContent(content);
  if (!clean) return null;
  const message = `${SMS_PREFIX} ${clean} ${SMS_FOOTER}`;
  return message.length <= MAX_SMS_LENGTH ? message : null;
}

/**
 * The live model is asked to stay inside the content budget. This defensive
 * truncation operates before the footer is appended, so no outbound SMS can
 * overflow the tool's 480-character contract.
 */
export function truncateSmsContent(content: string) {
  const clean = normalizedContent(content);
  if (clean.length <= MAX_SMS_CONTENT_LENGTH) return clean;
  return `${clean.slice(0, MAX_SMS_CONTENT_LENGTH - 1).trimEnd()}…`;
}
