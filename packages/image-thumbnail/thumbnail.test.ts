import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { composeStrip, loadThumbnail, TILE_GAP, TILE_HEIGHT, TILE_WIDTH } from "./thumbnail.ts";

function solidPng(width: number, height: number, color: number[]): Buffer {
	const bytes = new Uint8Array(width * height * 4);
	for (let offset = 0; offset < bytes.length; offset += 4) bytes.set(color, offset);
	const image = new PhotonImage(bytes, width, height);
	try { return Buffer.from(image.get_bytes()); } finally { image.free(); }
}

test("Photon preserves aspect ratio and composes oldest left, newest right", async () => {
	const dir = await mkdtemp(join(tmpdir(), "image-thumbnail-"));
	try {
		const red = join(dir, "red.png");
		const blue = join(dir, "blue.png");
		await writeFile(red, solidPng(40, 80, [255, 0, 0, 255]));
		await writeFile(blue, solidPng(80, 40, [0, 0, 255, 255]));
		const first = await loadThumbnail(red);
		const second = await loadThumbnail(blue);
		assert.ok(first);
		assert.ok(second);
		const strip = await composeStrip([first, second]);
		assert.equal(strip.widthPx, TILE_WIDTH * 2 + TILE_GAP);
		assert.equal(strip.heightPx, TILE_HEIGHT);
		const image = PhotonImage.new_from_byteslice(Buffer.from(strip.data, "base64"));
		try {
			const pixels = image.get_raw_pixels();
			const pixel = (x: number, y: number) => Array.from(pixels.slice((y * strip.widthPx + x) * 4, (y * strip.widthPx + x) * 4 + 4));
			assert.deepEqual(pixel(120, 80), [255, 0, 0, 255]);
			assert.deepEqual(pixel(5, 80), [0, 0, 0, 0]);
			assert.deepEqual(pixel(TILE_WIDTH + TILE_GAP + 120, 80), [0, 0, 255, 255]);
			assert.deepEqual(pixel(TILE_WIDTH + 5, 80), [0, 0, 0, 0]);
		} finally { image.free(); }
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("unreadable, oversized, and invalid images fail without throwing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "image-thumbnail-"));
	try {
		assert.equal(await loadThumbnail(join(dir, "missing.png")), undefined);
		assert.equal(await loadThumbnail(dir), undefined);
		const invalid = join(dir, "invalid.png");
		await writeFile(invalid, "not an image");
		assert.equal(await loadThumbnail(invalid), undefined);
		await writeFile(invalid, Buffer.alloc(20 * 1024 * 1024 + 1));
		assert.equal(await loadThumbnail(invalid), undefined);
		await assert.rejects(composeStrip([]), /empty/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
