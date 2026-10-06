# 9Router image provider for Pi

Use 9Router image models through `models.generateImages()` in codemode. Requires Pi 1.0.4 or later.

The provider uses the name `9router-images`. It does not change your chat providers.

## Install

Requires Pi 1.0.4 or later and a running 9Router service with an image-capable upstream account.

```sh
pi install npm:@mblarsen/pi-9router-image-provider
```

Run `/reload` or restart Pi after installation.
Enable codemode by adding `"+codemode"` to `defaultTools` in your Pi settings:

```json
{
  "defaultTools": ["+codemode"]
}
```

Preserve any existing `defaultTools` entries. Image models are available through codemode, not the chat `/model` selector.

## Configure

- `NINEROUTER_URL`: service root, default `http://127.0.0.1:20128`. A trailing `/v1` is also accepted.
- `NINEROUTER_KEY`: API key. If absent, the provider reads `~/.config/9router/pi-api-key`.

Use HTTPS for remote services. The provider does not store your key in project files or Pi settings.

The extension discovers models from `/v1/models/image` at startup, with a five-second network timeout.
If discovery fails, Pi still starts. Run `/9router-images-refresh` after you restore the service or credentials.
Restart or reload after changing environment variables or the service URL.

## Generate an image

Ask Pi to generate an image with the native `9router-images` provider. The agent can run:

```js
const available = await models.getAvailableOfType("image", "9router-images");
text(available.map(({ id }) => id));
```

Then use a discovered model ID:

```js
const result = await models.generateImages(
  { provider: "9router-images", id: "gemini/gemini-2.5-flash-image" },
  { input: [{ type: "text", text: "A watercolor fox tending basil" }] },
);
if (result.stopReason !== "stop") throw new Error(result.errorMessage);
for (const block of result.output) {
  if (block.type === "image") image(block);
}
```

`image()` displays the image and saves a temporary file. Copy that file if you need a permanent asset.

## Make native generation the default

If another image skill directs your agent to HTTP commands, add this instruction to your `AGENTS.md`:

> For image generation in Pi, first discover models with `models.getAvailableOfType("image", "9router-images")`. Use `models.generateImages()` and display image blocks with `image(block)`. Use HTTP only for explicit API work or when native generation cannot support the request. Explain the fallback reason before sending a request.

This instruction guides the agent. The extension does not override other skills or edit your instructions.

## Scope and limits

- Text-to-image only. Reference images and editing are rejected before the request.
- One image per request through `/v1/images/generations?response_format=binary`.
- Supports PNG, JPEG, GIF, and WebP responses. A model must support the endpoint's binary response mode.
- JSON and SSE responses are rejected. Model discovery does not prove upstream account availability.
- Cancellation, custom fetch, request headers, and payload/response hooks are supported.
- Binary responses contain no token usage or cost. Pi therefore cannot account for these generation charges.
- Catalog prices are zero placeholders, not a claim that generation is free. Check 9Router or the upstream provider for charges.

## Development

For a local checkout, create a directory symlink from the repository root:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/packages/9router-image-provider" ~/.pi/agent/extensions/9router-image-provider
```

Use either the npm installation or the symlink, not both. Run `/reload` after changing the installation.
The directory symlink loads only `index.ts`, not the test or adapter files.

From the repository root, run:

```sh
npm ci
npm run check
npx changeset status
```

Unit tests use mocked requests and do not incur image-generation charges.
The package has Pi 1.0.4 development dependencies because older workspace types lack the image-provider API.
