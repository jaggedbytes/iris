import { randomUUID } from "node:crypto";

import type { IrisRepositories } from "./db/repositories.js";
import type { MemoryCategory } from "./db/types.js";

const EXTRACTION_TIMEOUT_MS = 30_000;

export type TranscriptTurn = { speaker: "user" | "assistant"; text: string };
export type CareSummary = {
  recap: string;
  moodAndConcerns: string[];
  irisSuggestedNextSteps: string[];
};

export type CallSummary = {
  status: "complete";
  recap: string;
  facts: string[];
  people: Array<{ name: string; relationshipOrContext: string }>;
  unresolvedTopics: string[];
  recallAnchor: string | null;
  careSummary: CareSummary | null;
} | {
  status: "insufficient_signal";
  recap: "";
  facts: [];
  people: [];
  unresolvedTopics: [];
  recallAnchor: null;
  careSummary: null;
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "recap", "facts", "people", "unresolvedTopics", "recallAnchor", "careSummary"],
  properties: {
    status: { type: "string", enum: ["complete", "insufficient_signal"] },
    recap: { type: "string", maxLength: 500 },
    facts: { type: "array", items: { type: "string", maxLength: 280 }, maxItems: 12 },
    people: {
      type: "array", maxItems: 12,
      items: { type: "object", additionalProperties: false, required: ["name", "relationshipOrContext"], properties: {
        name: { type: "string", maxLength: 120 }, relationshipOrContext: { type: "string", maxLength: 280 },
      } },
    },
    unresolvedTopics: { type: "array", items: { type: "string", maxLength: 280 }, maxItems: 12 },
    recallAnchor: { type: ["string", "null"], maxLength: 160 },
    careSummary: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["recap", "moodAndConcerns", "irisSuggestedNextSteps"],
      properties: {
        recap: { type: "string", maxLength: 500 },
        moodAndConcerns: { type: "array", items: { type: "string", maxLength: 280 }, maxItems: 8 },
        irisSuggestedNextSteps: { type: "array", items: { type: "string", maxLength: 280 }, maxItems: 8 },
      },
    },
  },
} as const;

function validText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0);
}

function validTextArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => validText(item, maxLength));
}

function validCareSummary(value: unknown): value is CareSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const care = value as Record<string, unknown>;
  return validText(care.recap, 500)
    && validTextArray(care.moodAndConcerns, 8, 280)
    && validTextArray(care.irisSuggestedNextSteps, 8, 280);
}

function valid(value: unknown): value is CallSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  if (summary.status === "insufficient_signal") {
    return Array.isArray(summary.facts) && summary.facts.length === 0
      && Array.isArray(summary.people) && summary.people.length === 0
      && Array.isArray(summary.unresolvedTopics) && summary.unresolvedTopics.length === 0
      && summary.recap === "" && summary.recallAnchor === null && summary.careSummary === null;
  }
  if (summary.status !== "complete" || !validText(summary.recap, 500, true)
    || !validTextArray(summary.facts, 12, 280)
    || !validTextArray(summary.unresolvedTopics, 12, 280)
    || (summary.recallAnchor !== null && !validText(summary.recallAnchor, 160))
    || !Array.isArray(summary.people) || summary.people.length > 12
    || !summary.people.every((person) => !!person && typeof person === "object"
      && validText((person as Record<string, unknown>).name, 120)
      && validText((person as Record<string, unknown>).relationshipOrContext, 280))
    || (summary.careSummary !== null && !validCareSummary(summary.careSummary))) return false;

  const hasNarrowSignal = summary.recap.trim().length > 0
    || summary.facts.length > 0
    || summary.people.length > 0
    || summary.unresolvedTopics.length > 0
    || summary.recallAnchor !== null;
  return hasNarrowSignal || summary.careSummary !== null;
}

const SSN_PATTERN = /\b\d{3}-?\d{2}-?\d{4}\b/;
const PAYMENT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
// High-confidence only: labeled DOB phrases plus a numeric date, not bare
// calendar mentions like "on Tuesday" or "in July."
const DATE_OF_BIRTH_PATTERN = /\b(?:dob|date of birth|born on)\b[:\s-]*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
// E.164 and common North American formatted numbers. Prefer 3-3-4 over SSN's 3-2-4.
const PHONE_PATTERN = /(?:\+[1-9]\d{7,14}\b|\b(?:\+?1[-.\s]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[-.\s]?\d{3}[-.\s]?\d{4}\b)/;
// House number plus an explicit street-type token; unnumbered street names stay allowed.
const PHYSICAL_ADDRESS_PATTERN = /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way)\b/i;

function isLuhnPaymentCard(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let total = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if ((digits.length - 1 - index) % 2 === 1) digit = digit > 4 ? digit * 2 - 9 : digit * 2;
    total += digit;
  }
  return total % 10 === 0;
}

function hasRecognizableIdentifier(careSummary: CareSummary) {
  const text = [careSummary.recap, ...careSummary.moodAndConcerns, ...careSummary.irisSuggestedNextSteps].join("\n");
  return SSN_PATTERN.test(text)
    || EMAIL_PATTERN.test(text)
    || PHONE_PATTERN.test(text)
    || PHYSICAL_ADDRESS_PATTERN.test(text)
    || DATE_OF_BIRTH_PATTERN.test(text)
    || [...text.matchAll(PAYMENT_CARD_PATTERN)].some((match) => isLuhnPaymentCard(match[0]));
}

function withoutMalformedCareSummary(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const summary = value as Record<string, unknown>;
  // A malformed or missing dashboard-only section must not discard otherwise
  // valid narrow memory. Other top-level schema failures still fail closed.
  if (summary.status === "complete" && !validCareSummary(summary.careSummary)) {
    return { ...summary, careSummary: null };
  }
  return value;
}

function withoutUnconsentedOrUnsafeCareSummary(summary: CallSummary, careSharingActive: boolean): CallSummary {
  if (summary.status !== "complete" || !summary.careSummary || !careSharingActive || hasRecognizableIdentifier(summary.careSummary)) {
    return summary.status === "complete" ? { ...summary, careSummary: null } : summary;
  }
  return summary;
}

function extractionInstructions(careSharingActive: boolean) {
  const narrow = "Extract narrow, explicitly user-stated memory only: durable facts, named people/context, unresolved topics, and a short non-sensitive recallAnchor suitable for a future gentle opener. Never infer mood, concern/risk, diagnosis, or medical/legal/financial conclusion. Ignore assistant suggestions in the narrow fields. Set recallAnchor to null for health, mood, risk, medical, legal, financial, sensitive, or insufficient signal.";
  const care = careSharingActive
    ? "careSummary is dashboard-only. Write a concise recap whenever the person shares a meaningful update, including explicitly discussed health-related feelings, symptoms, concerns, or plans. moodAndConcerns and irisSuggestedNextSteps may be empty. Include a mood or concern only when the person explicitly stated it; never infer one. Include every direct Iris suggestion that was actually said, including guidance to contact a medical provider, and clearly attribute it as an Iris suggestion. Do not turn the recap into a diagnosis, prognosis, risk classification, treatment plan, or professional conclusion; do not add advice Iris did not say. Never include legal matters, financial or payment details, account information, credentials, passcodes, SSNs, payment-card numbers, phone numbers, email addresses, physical addresses, dates of birth, or assistant inference. Set careSummary to null only when there is no meaningful shareable update or its content is unsafe to share."
    : "Set careSummary to null. Do not extract mood, concern, or assistant suggestions.";
  return `${narrow} ${care} Return insufficient_signal only when there is no reliable narrow memory and no valid careSummary.`;
}

export type SummaryRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CallSummaryPipeline {
  constructor(private readonly repositories: IrisRepositories, private readonly apiKey: string, private readonly safetyIdentifier: string, private readonly request: SummaryRequest = fetch) {}

  async process(input: { callId: string; personId: string; transcript: TranscriptTurn[] }) {
    if (!this.repositories.hasActiveConsent(input.personId, "summary_retention") || input.transcript.length === 0) {
      this.repositories.updateCallSummaryState({ id: input.callId, summaryState: "not_requested" });
      return;
    }
    this.repositories.updateCallSummaryState({ id: input.callId, summaryState: "processing" });
    const transcript = input.transcript.map((turn) => `${turn.speaker === "user" ? "User" : "Iris"}: ${turn.text}`).join("\n");
    // The care section is requested in the same extraction, never as a second
    // billable call. Recheck this consent again before writing because it is
    // revocable while the model request is in flight.
    const careSharingAtRequest = this.repositories.hasActiveConsent(input.personId, "care_summary_sharing");
    try {
      const response = await this.request("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": this.safetyIdentifier },
        // This runs as an unawaited background task, so bound it: a hung upstream
        // connection aborts here instead of leaking resources indefinitely.
        signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        body: JSON.stringify({
          model: "gpt-5.6-terra", store: false, safety_identifier: this.safetyIdentifier,
          input: [
            { role: "developer", content: extractionInstructions(careSharingAtRequest) },
            { role: "user", content: transcript },
          ],
          text: { format: { type: "json_schema", name: "iris_call_summary", strict: true, schema } },
        }),
      });
      if (!response.ok) {
        this.markUnavailable(input);
        return;
      }
      const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const raw = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
      if (!raw) {
        this.markUnavailable(input);
        return;
      }
      const extracted = withoutMalformedCareSummary(JSON.parse(raw) as unknown);
      // Recheck revocable consent immediately before every durable write.
      if (!valid(extracted) || !this.repositories.hasActiveConsent(input.personId, "summary_retention")) {
        this.markUnavailable(input);
        return;
      }
      const summary = withoutUnconsentedOrUnsafeCareSummary(
        extracted,
        careSharingAtRequest && this.repositories.hasActiveConsent(input.personId, "care_summary_sharing"),
      );
      if (!valid(summary) || summary.status === "insufficient_signal") {
        this.markUnavailable(input);
        return;
      }
      // Normalize once before every durable write. The raw model string is not
      // retained when it carries harmless leading/trailing whitespace.
      const recallAnchor = summary.recallAnchor?.trim() ?? null;
      const summaryForPersistence = { ...summary, recallAnchor };
      const memories: Array<{ id: string; category: MemoryCategory; payload: unknown }> = [
        ...summary.facts.map((fact) => ({ id: randomUUID(), category: "durable_fact" as const, payload: { fact } })),
        ...summary.people.map((person) => ({ id: randomUUID(), category: "named_person" as const, payload: person })),
        ...summary.unresolvedTopics.map((topic) => ({ id: randomUUID(), category: "unresolved_topic" as const, payload: { topic } })),
        ...(recallAnchor ? [{ id: randomUUID(), category: "recall_anchor" as const, payload: { anchor: recallAnchor } }] : []),
      ];
      if (!this.repositories.finalizeCallSummary({
        callId: input.callId,
        personId: input.personId,
        summaryJson: JSON.stringify(summaryForPersistence),
        readyEventId: randomUUID(),
        memories,
      })) {
        this.markUnavailable(input);
      }
    } catch {
      // Raw transcript text is never logged or persisted on extraction failure.
      this.markUnavailable(input);
    }
  }

  private markUnavailable(input: { callId: string; personId: string }) {
    if (this.repositories.updateCallSummaryState({ id: input.callId, summaryState: "unavailable" })) {
      this.repositories.createEvent({ id: randomUUID(), personId: input.personId, callId: input.callId, type: "call.summary_unavailable", payload: {} });
    }
  }
}
