export const PREVIEW_MS = 3_000;

/** Match clipboard paths, not arbitrary images mentioned in a prompt. */
export function clipboardPaths(text: string): string[] {
	const tokens = text.match(/"[^"\r\n]+"|'[^'\r\n]+'|[^\s"']+/g) ?? [];
	return tokens.flatMap((token) => {
		const path = token.replace(/^["']|["']$/g, "");
		return /^(?:\/|[A-Za-z]:\\).*[/\\]pi-clipboard-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(?:png|jpe?g|webp|gif)$/i.test(path)
			? [path]
			: [];
	});
}

export function addedPaths(previous: readonly string[], current: readonly string[]): string[] {
	const remaining = new Map<string, number>();
	for (const path of previous) remaining.set(path, (remaining.get(path) ?? 0) + 1);
	return current.filter((path) => {
		const count = remaining.get(path) ?? 0;
		if (!count) return true;
		remaining.set(path, count - 1);
		return false;
	});
}

export interface Preview<T> {
	id: number;
	value: T;
	expiresAt?: number;
}

/** Timers start on first render, not while files are loading. */
export class PreviewQueue<T> {
	items: Preview<T>[] = [];
	private nextId = 0;

	add(value: T): void {
		this.items.push({ id: this.nextId++, value });
	}

	markDisplayed(ids: readonly number[], now: number): void {
		const displayed = new Set(ids);
		for (const item of this.items) {
			if (displayed.has(item.id)) item.expiresAt ??= now + PREVIEW_MS;
		}
	}

	expire(now: number): boolean {
		const count = this.items.length;
		this.items = this.items.filter((item) => item.expiresAt === undefined || item.expiresAt > now);
		return this.items.length !== count;
	}

	nextExpiry(): number | undefined {
		const times = this.items.flatMap((item) => item.expiresAt === undefined ? [] : [item.expiresAt]);
		return times.length ? Math.min(...times) : undefined;
	}
}
