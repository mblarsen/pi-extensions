import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImageModel } from "@earendil-works/pi-ai";
import { API, PROVIDER, baseUrl, discoverModels, generateImages, imageMime, readKey } from "./provider.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const model: ImageModel<typeof API> = {
  type: "image", id: "gemini/test", name: "Test", provider: PROVIDER, api: API,
  baseUrl: "http://localhost:20128/v1", input: ["text"], output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { input: [{ type: "text" as const, text: "A fox" }] };

// Injection keeps unit tests offline and avoids real generation charges.
const imageFetch: typeof fetch = async () => new Response(png, { headers: { "Content-Type": "image/png" } });

test("normalizes service URLs and rejects embedded credentials", () => {
  assert.equal(baseUrl({}), "http://127.0.0.1:20128");
  assert.equal(baseUrl({ NINEROUTER_URL: "https://example.com/v1/" }), "https://example.com");
  assert.throws(() => baseUrl({ NINEROUTER_URL: "https://secret@example.com" }));
  assert.throws(() => baseUrl({ NINEROUTER_URL: "file:///tmp" }));
});

test("reads credentials from environment before key file", async () => {
  const home = await mkdtemp(join(tmpdir(), "9router-key-test-"));
  try {
    await mkdir(join(home, ".config/9router"), { recursive: true });
    await writeFile(join(home, ".config/9router/pi-api-key"), "file-key\n", { mode: 0o600 });
    assert.equal(await readKey({ NINEROUTER_KEY: " env-key " }, home), "env-key");
    assert.equal(await readKey({}, home), "file-key");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovers deduplicated text-only image models with bounded authenticated request", async () => {
  const catalog = await discoverModels("http://localhost:20128", "test-key", undefined, async (url, init) => {
    assert.equal(url, "http://localhost:20128/v1/models/image");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    assert.ok(init?.signal);
    assert.equal(init?.redirect, "error");
    return Response.json({ data: [{ id: "cx/test" }, { id: "cx/test" }] });
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].type, "image");
  assert.deepEqual(catalog[0].input, ["text"]);
  assert.equal(catalog[0].baseUrl, "http://localhost:20128/v1");
});

test("rejects invalid catalogs and HTTP failures", async () => {
  for (const data of [{}, { data: [null] }, { data: [{ id: "" }] }]) {
    await assert.rejects(discoverModels("http://localhost", "key", undefined, async () => Response.json(data)), /invalid/);
  }
  await assert.rejects(discoverModels("http://localhost", "key", undefined, async () => new Response("secret", { status: 401 })), /HTTP 401/);
});

test("generates native image blocks and honors request hooks and custom transport", async () => {
  let responseHook = false;
  const result = await generateImages(model, context, {
    apiKey: "test-key",
    onPayload: (payload) => ({ ...payload as object, prompt: "Another fox" }),
    onResponse: (response) => { assert.equal(response.status, 200); responseHook = true; },
    fetch: async (url, init) => {
      assert.equal(url, "http://localhost:20128/v1/images/generations?response_format=binary");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
      assert.deepEqual(JSON.parse(String(init?.body)), { model: model.id, prompt: "Another fox", n: 1 });
      assert.equal(init?.redirect, "error");
      return imageFetch(url, init);
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(responseHook, true);
  assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
  assert.equal(result.usage, undefined);
});

test("rejects empty prompts and reference images without making a request", async () => {
  const noFetch: typeof fetch = async () => { assert.fail("Must not call upstream"); };
  for (const input of [[], [{ type: "text" as const, text: " " }], [{ type: "image" as const, data: "abc", mimeType: "image/png" }]]) {
    const result = await generateImages(model, { input }, { apiKey: "key", fetch: noFetch });
    assert.equal(result.stopReason, "error");
  }
});

test("HTTP errors do not expose upstream response bodies", async () => {
  const result = await generateImages(model, context, {
    apiKey: "key", fetch: async () => new Response("private prompt and secret", { status: 503 }),
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /503/);
  assert.doesNotMatch(result.errorMessage!, /private|secret/);
});

test("rejects JSON or SSE disguised as successful binary responses", async () => {
  const result = await generateImages(model, context, { apiKey: "key", fetch: async () => Response.json({ error: "private" }) });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /supported image/);
});

test("handles cancellation before and during fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const first = await generateImages(model, context, { signal: controller.signal });
  assert.equal(first.stopReason, "aborted");
  const during = new AbortController();
  const second = await generateImages(model, context, {
    apiKey: "key", signal: during.signal,
    fetch: async (_url, init) => { assert.equal(init?.signal, during.signal); during.abort(); throw new Error("cancelled"); },
  });
  assert.equal(second.stopReason, "aborted");
});

test("recognizes supported image signatures", () => {
  assert.equal(imageMime(png), "image/png");
  assert.equal(imageMime(Buffer.from([255, 216, 255, 0])), "image/jpeg");
  assert.equal(imageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageMime(Buffer.from("RIFFxxxxWEBP")), "image/webp");
  assert.throws(() => imageMime(Buffer.alloc(0)));
});
