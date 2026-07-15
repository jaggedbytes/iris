import { irisV1 } from "./personas/iris-v1.js";

const REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

type CreateClientSecretOptions = {
  apiKey: string;
  request?: typeof fetch;
};

/**
 * Creates the short-lived credential the browser will use for a direct WebRTC
 * connection. OPENAI_API_KEY stays on this server and is never returned.
 */
export async function createRealtimeClientSecret({
  apiKey,
  request = fetch,
}: CreateClientSecretOptions) {
  const safetyIdentifier =
    process.env.IRIS_SAFETY_IDENTIFIER ?? "iris-local-prototype";

  const upstream = await request(REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: irisV1,
        audio: {
          output: {
            voice: "marin",
          },
        },
      },
    }),
  });

  if (!upstream.ok) {
    throw new Error(`OpenAI Realtime returned ${upstream.status}.`);
  }

  return upstream.json() as Promise<unknown>;
}
