import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { API, PROVIDER } from "./provider.ts";

function setTestKey(t: TestContext) {
  const previous = process.env.NINEROUTER_KEY;
  process.env.NINEROUTER_KEY = "test-key";
  t.after(() => {
    if (previous === undefined) delete process.env.NINEROUTER_KEY;
    else process.env.NINEROUTER_KEY = previous;
  });
}

test("extension registers models usable through Pi's native image runtime", async (t) => {
  setTestKey(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "gemini/test" }] }));
  const dir = await mkdtemp(join(tmpdir(), "9router-runtime-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), refreshOnCreate: false,
  });
  const host = {
    registerProvider: (name: string, config: ProviderConfig) => runtime.registerProvider(name, config),
    on: () => {}, registerCommand: () => {},
  };
  await extension(host as unknown as ExtensionAPI);
  const models = await runtime.getAvailableOfType("image", PROVIDER);
  assert.equal(models.length, 1);
  assert.equal(models[0].api, API);
  assert.equal(runtime.getModels(PROVIDER).length, 0);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const result = await runtime.generateImages(models[0], { input: [{ type: "text", text: "Fox" }] }, {
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
      return new Response(png);
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.output[0].type, "image");
});

test("failed discovery does not block extension loading and refresh can recover", async (t) => {
  setTestKey(t);
  let available = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (!available) throw new Error("Service offline");
    return Response.json({ data: [{ id: "gemini/recovered" }] });
  });
  let config: ProviderConfig | undefined;
  const host = {
    registerProvider: (_name: string, value: ProviderConfig) => { config = value; },
    on: () => {}, registerCommand: () => {},
  };
  await extension(host as unknown as ExtensionAPI);
  assert.deepEqual(config?.models, []);
  assert.ok(config?.refreshModels);
  available = true;
  // The refresh implementation only consumes the optional signal.
  const models = await config.refreshModels({} as Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0]);
  assert.equal(models[0].id, "gemini/recovered");
});
