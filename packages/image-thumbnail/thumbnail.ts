import { open } from "node:fs/promises";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { PhotonImage, resize, SamplingFilter, watermark } from "@silvia-odwyer/photon-node";

export const TILE_WIDTH = 240;
export const TILE_HEIGHT = 160;
export const TILE_GAP = 16;
const MAX_BYTES = 20 * 1024 * 1024;

export async function loadThumbnail(path: string): Promise<Buffer | undefined> {
	try {
		const file = await open(path, "r");
		let bytes: Buffer;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
			// Bound the read even if a file grows after stat().
			const buffer = Buffer.alloc(stat.size + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > stat.size) return undefined;
			bytes = buffer.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
		const extension = path.split(".").pop()?.toLowerCase();
		const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
		const dimensions = getImageDimensions(bytes.toString("base64"), mime);
		if (!dimensions || dimensions.widthPx * dimensions.heightPx > 40_000_000) return undefined;
		const source = PhotonImage.new_from_byteslice(bytes);
		let scaled: PhotonImage | undefined;
		let tile: PhotonImage | undefined;
		try {
			const scale = Math.min(TILE_WIDTH / source.get_width(), TILE_HEIGHT / source.get_height());
			const width = Math.max(1, Math.round(source.get_width() * scale));
			const height = Math.max(1, Math.round(source.get_height() * scale));
			scaled = resize(source, width, height, SamplingFilter.Lanczos3);
			tile = new PhotonImage(new Uint8Array(TILE_WIDTH * TILE_HEIGHT * 4), TILE_WIDTH, TILE_HEIGHT);
			watermark(tile, scaled, BigInt(Math.floor((TILE_WIDTH - width) / 2)), BigInt(Math.floor((TILE_HEIGHT - height) / 2)));
			return Buffer.from(tile.get_bytes());
		} finally {
			tile?.free();
			scaled?.free();
			source.free();
		}
	} catch {
		return undefined;
	}
}

export async function composeStrip(tiles: readonly Buffer[]): Promise<{ data: string; widthPx: number; heightPx: number }> {
	const widthPx = tiles.length * TILE_WIDTH + (tiles.length - 1) * TILE_GAP;
	if (!tiles.length) throw new Error("Cannot compose an empty thumbnail strip");
	const strip = new PhotonImage(new Uint8Array(widthPx * TILE_HEIGHT * 4), widthPx, TILE_HEIGHT);
	try {
		for (const [index, bytes] of tiles.entries()) {
			const tile = PhotonImage.new_from_byteslice(bytes);
			try {
				watermark(strip, tile, BigInt(index * (TILE_WIDTH + TILE_GAP)), 0n);
			} finally {
				tile.free();
			}
		}
		return { data: Buffer.from(strip.get_bytes()).toString("base64"), widthPx, heightPx: TILE_HEIGHT };
	} finally {
		strip.free();
	}
}
