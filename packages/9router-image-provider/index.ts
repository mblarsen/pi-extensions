import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API, PROVIDER, baseUrl, discoverModels, generateImages, readKey, type ProviderImageModelConfig } from "./provider.ts";

export default async function (pi: ExtensionAPI) {
  const url = baseUrl();
  const refresh = async (signal?: AbortSignal) => discoverModels(url, await readKey(), signal);
  let models: ProviderImageModelConfig[] = [];
  let discoveryFailed = false;
  try {
    models = await refresh();
  } catch {
    discoveryFailed = true;
  }

  // Resolve credentials for each request; never copy the key into Pi settings or logs.
  const apiKey = process.env.NINEROUTER_KEY?.trim()
    ? "$NINEROUTER_KEY"
    : '!cat "$HOME/.config/9router/pi-api-key"';
  const register = (catalog: ProviderImageModelConfig[]) => pi.registerProvider(PROVIDER, {
    name: "9Router Images",
    baseUrl: `${url}/v1`,
    apiKey,
    models: catalog,
    images: { [API]: { generateImages } },
    refreshModels: ({ signal }) => refresh(signal),
  });
  register(models);

  pi.on("session_start", async (_event, ctx) => {
    if (discoveryFailed && ctx.hasUI) {
      ctx.ui.notify("9Router image discovery failed. Check the service and key, then run /9router-images-refresh.", "warning");
    }
  });

  pi.registerCommand("9router-images-refresh", {
    description: "Refresh the native 9Router image model catalog",
    handler: async (_args, ctx) => {
      try {
        const catalog = await refresh();
        register(catalog);
        discoveryFailed = false;
        ctx.ui.notify(`Loaded ${catalog.length} 9Router image models.`, "info");
      } catch {
        ctx.ui.notify("9Router image discovery failed. Check NINEROUTER_URL, credentials, and service availability.", "error");
      }
    },
  });
}
