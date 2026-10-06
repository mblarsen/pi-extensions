import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantImages, ImagesFunction } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ProviderImageModelConfig = Extract<ProviderModelConfig, { type: "image" }>;

export const PROVIDER = "9router-images";
export const API = "9router-image-generations";
export const DEFAULT_URL = "http://127.0.0.1:20128";

export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(env.NINEROUTER_URL || DEFAULT_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("NINEROUTER_URL must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function readKey(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> {
  const key = env.NINEROUTER_KEY?.trim() || (await readFile(join(home, ".config/9router/pi-api-key"), "utf8")).trim();
  if (!key) throw new Error("Set NINEROUTER_KEY or provide ~/.config/9router/pi-api-key.");
  return key;
}

export async function discoverModels(
  url: string,
  key: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ProviderImageModelConfig[]> {
  const response = await request(`${url}/v1/models/image`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`9Router model discovery failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("9Router returned an invalid image model catalog.");
  }
  const ids = new Set<string>();
  for (const entry of body.data) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error("9Router returned an invalid image model ID.");
    }
    ids.add(entry.id);
  }
  return [...ids].map((id) => ({
    type: "image",
    id,
    name: `${id} (9Router)`,
    api: API,
    baseUrl: `${url}/v1`,
    input: ["text"],
    output: ["image"],
    // The discovery endpoint supplies no pricing; do not invent per-token rates.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

export function imageMime(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("9Router did not return a supported image (PNG, JPEG, GIF, or WebP).");
}

export const generateImages: ImagesFunction = async (model, context, options = {}) => {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "error",
    timestamp: Date.now(),
  };
  try {
    options.signal?.throwIfAborted();
    if (context.input.some((block) => block.type !== "text")) {
      throw new Error("This provider currently supports text-to-image only, not reference images or editing.");
    }
    const prompt = context.input.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (!prompt.trim()) throw new Error("An image prompt is required.");
    const key = options.apiKey || await readKey({ ...process.env, ...options.env });
    const payload = { model: model.id, prompt, n: 1 };
    const replacement = await options.onPayload?.(payload, model);
    const headers = new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });
    for (const source of [model.headers, options.headers]) {
      for (const [name, value] of Object.entries(source ?? {})) {
        if (value === null) headers.delete(name);
        else if (value !== undefined) headers.set(name, value);
      }
    }
    const response = await (options.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/images/generations?response_format=binary`, {
      method: "POST",
      headers,
      body: JSON.stringify(replacement === undefined ? payload : replacement),
      signal: options.signal,
      redirect: "error",
    });
    await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    // Do not echo upstream response bodies: they may contain prompts or credentials.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`9Router image generation failed (HTTP ${response.status}). Check 9Router account availability and credentials.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    options.signal?.throwIfAborted();
    const mimeType = imageMime(bytes);
    result.output = [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }];
    result.stopReason = "stop";
    // Binary responses contain no usage, so leave usage absent rather than report zero cost.
  } catch (error) {
    result.stopReason = options.signal?.aborted ? "aborted" : "error";
    result.errorMessage = options.signal?.aborted ? "Image generation aborted." :
      error instanceof Error ? error.message : "9Router image generation failed.";
  }
  return result;
};
