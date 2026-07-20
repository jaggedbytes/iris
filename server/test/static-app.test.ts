import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";

test("serves built SPA routes without shadowing API or health endpoints", async () => {
  const staticDir = await mkdtemp(join(tmpdir(), "iris-static-"));
  await writeFile(join(staticDir, "index.html"), "<html><body>Iris hosted app</body></html>");
  await writeFile(join(staticDir, "asset.txt"), "static asset");
  const app = createApp({ staticDir });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const [optIn, calls, asset, health, api, media] = await Promise.all([
      fetch(`${baseUrl}/opt-in?token=opaque`),
      fetch(`${baseUrl}/calls`),
      fetch(`${baseUrl}/asset.txt`),
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/api/unknown`),
      fetch(`${baseUrl}/api/telephony/media`),
    ]);
    assert.equal(optIn.status, 200);
    assert.equal(await optIn.text(), "<html><body>Iris hosted app</body></html>");
    assert.equal(calls.status, 200);
    assert.equal(await calls.text(), "<html><body>Iris hosted app</body></html>");
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "static asset");
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(api.status, 404);
    assert.equal(media.status, 404);
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});
