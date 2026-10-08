import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setCapabilities, type Component } from "@earendil-works/pi-tui";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { startPreviews } from "./index.ts";

test("widget polls async paste, preserves focus, expires separately, and disposes", { timeout: 10_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const dir = await mkdtemp(join(tmpdir(), "image-thumbnail-"));
	const first = join(dir, "pi-clipboard-12345678-abcd-4321-abcd-123456789abc.png");
	const second = join(dir, "pi-clipboard-87654321-abcd-4321-abcd-123456789abc.png");
	const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
	try {
		await writeFile(first, image.get_bytes());
		await writeFile(second, image.get_bytes());
	} finally { image.free(); }
	let text = "";
	let component: Component | undefined;
	let notify: (() => void) | undefined;
	const nextWidget = () => new Promise<void>((resolve) => { notify = resolve; });
	const ctx = {
		ui: {
			getEditorText: () => text,
			setWidget: (_key: string, factory: ((tui: unknown) => Component) | undefined) => {
				component = factory?.({ terminal: { rows: 40 } });
				if (component) { notify?.(); notify = undefined; }
			},
		},
	} as unknown as ExtensionContext;
	const previews = startPreviews(ctx);
	try {
		let ready = nextWidget();
		text = first;
		t.mock.timers.tick(75);
		await ready;
		const single = component!.render(100);
		assert.ok(single[0].startsWith(" "));
		assert.match(single[0], /\x1b_G/);
		assert.equal(component!.handleInput, undefined);
		assert.equal(text, first);
		t.mock.timers.tick(1_000);
		ready = nextWidget();
		text += ` ${second}`;
		previews.observe(text);
		await ready;
		const row = component!.render(100);
		assert.equal(row[0].match(/\x1b_Ga=T/g)?.length, 1);
		assert.ok(row[0].search(/\S/) < single[0].search(/\S/));
		assert.ok(component!.render(20).length <= 8);
		ready = nextWidget();
		t.mock.timers.tick(2_000);
		await ready;
		component!.render(100);
		assert.ok(component);
		t.mock.timers.tick(1_000);
		assert.equal(component, undefined);
		assert.equal(text, `${first} ${second}`);
	} finally {
		previews.dispose();
		await rm(dir, { recursive: true, force: true });
	}
	t.mock.timers.tick(10_000);
	assert.equal(component, undefined);
});
