import { randomUUID } from "node:crypto";

import type { IrisRepositories } from "./db/repositories.js";
import type { MemoryCategory } from "./db/types.js";

const EXTRACTION_TIMEOUT_MS = 30_000;

export type TranscriptTurn = { speaker: "user" | "assistant"; text: string };
export type CallSummary = {
  status: "complete";
  recap: string;
  facts: string[];
  people: Array<{ name: string; relationshipOrContext: string }>;
  unresolvedTopics: string[];
  recallAnchor: string | null;
} | {
  status: "insufficient_signal";
  recap: "";
  facts: [];
  people: [];
  unresolvedTopics: [];
  recallAnchor: null;
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "recap", "facts", "people", "unresolvedTopics", "recallAnchor"],
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
  },
} as const;

function valid(value: unknown): value is CallSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  if (summary.status === "insufficient_signal") {
    return Array.isArray(summary.facts) && Array.isArray(summary.people) && Array.isArray(summary.unresolvedTopics) && summary.recap === "" && summary.recallAnchor === null;
  }
  return summary.status === "complete" && typeof summary.recap === "string" && summary.recap.trim().length > 0 &&
    [summary.facts, summary.people, summary.unresolvedTopics].every(Array.isArray) &&
    (summary.recallAnchor === null || (typeof summary.recallAnchor === "string" && summary.recallAnchor.trim().length > 0 && summary.recallAnchor.trim().length <= 160)) &&
    (summary.facts as unknown[]).every((x) => typeof x === "string") &&
    (summary.people as unknown[]).every((x) => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).name === "string" && typeof (x as Record<string, unknown>).relationshipOrContext === "string") &&
    (summary.unresolvedTopics as unknown[]).every((x) => typeof x === "string");
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
    try {
      const response = await this.request("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": this.safetyIdentifier },
        // This runs as an unawaited background task, so bound it: a hung upstream
        // connection aborts here instead of leaking resources indefinitely.
        signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        body: JSON.stringify({
          model: "gpt-5.6-terra", store: false, safety_identifier: this.safetyIdentifier,
          input: [
            { role: "developer", content: "Extract only durable, explicitly user-stated memory. Never infer mood, concern/risk, diagnosis, or medical/legal/financial conclusion. Ignore all assistant suggestions. recallAnchor is one short, non-sensitive user-stated conversational thread suitable for a future gentle opener; set it to null for health, mood, risk, medical, legal, financial, sensitive, or insufficient signal. Return insufficient_signal if there is no reliable user-stated memory." },
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
      const summary = JSON.parse(raw) as unknown;
      // Recheck revocable consent immediately before every durable write.
      if (!valid(summary) || summary.status === "insufficient_signal" || !this.repositories.hasActiveConsent(input.personId, "summary_retention")) {
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
