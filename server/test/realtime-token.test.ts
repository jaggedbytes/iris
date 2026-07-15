import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";

test("mints a short-lived Realtime client secret without exposing the API key", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousIdentifier = process.env.IRIS_SAFETY_IDENTIFIER;
  process.env.OPENAI_API_KEY = "sk-test-secret";
  process.env.IRIS_SAFETY_IDENTIFIER = "iris-test-user";

  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const app = createApp({
    request: async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return Response.json({
        value: "ek_test_client_secret",
        expires_at: 1_800_000_000,
      });
    },
  });

  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/realtime/token`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      value: "ek_test_client_secret",
      expires_at: 1_800_000_000,
    });

    assert.equal(
      requestedUrl,
      "https://api.openai.com/v1/realtime/client_secrets",
    );
    assert.equal(
      new Headers(requestedInit?.headers).get("authorization"),
      "Bearer sk-test-secret",
    );
    assert.equal(
      new Headers(requestedInit?.headers).get("openai-safety-identifier"),
      "iris-test-user",
    );

    const body = JSON.parse(String(requestedInit?.body));
    assert.equal(body.session.model, "gpt-realtime-2.1");
    assert.equal(body.session.audio.output.voice, "marin");
    assert.equal(body.expires_after.seconds, 600);
  } finally {
    server.close();
    process.env.OPENAI_API_KEY = previousKey;
    process.env.IRIS_SAFETY_IDENTIFIER = previousIdentifier;
  }
});

test("returns a configuration error when OPENAI_API_KEY is missing", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const app = createApp();
  const server = app.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/realtime/token`,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "OPENAI_API_KEY is not configured.",
    });
  } finally {
    server.close();
    process.env.OPENAI_API_KEY = previousKey;
  }
});
