import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sep } from "node:path";
import { expect, test } from "vitest";

// Both native bridges allow exactly one Zero sync path and bound inbound binary frames.
// A Zero upgrade that changes either must update the native pins in the same change, or
// native sync never connects while web keeps working.
const zeroEntry = createRequire(import.meta.url).resolve("@rocicorp/zero");
// Native separators: Windows desktop CI resolves backslash paths.
const zeroRoot = zeroEntry.slice(0, zeroEntry.lastIndexOf(`${sep}out${sep}`));
const read = (path: string | URL) => readFileSync(path, "utf8");
const repo = (path: string) =>
	read(new URL(`../../../${path}`, import.meta.url));

function only(source: string, pattern: RegExp, label: string): string {
	const found = new Set([...source.matchAll(pattern)].map((m) => m[1]));
	if (found.size !== 1)
		throw new Error(`${label}: expected one value, found ${[...found]}`);
	return [...found][0] as string;
}

const product = (expression: string) =>
	expression.split("*").reduce((total, factor) => total * Number(factor), 1);

test("native socket pins equal the bundled Zero client's sync path", () => {
	const client = only(
		read(`${zeroRoot}/out/zero-client/src/client/zero.js`),
		/["'`](\/sync\/v\d+\/connect)["'`]/g,
		"Zero client",
	);
	expect(
		only(
			repo(
				"apps/android/android/app/src/main/java/io/ditero/app/ServerContext.java",
			),
			/ZERO_SOCKET_PATH = "([^"]*)";/g,
			"Android",
		),
	).toBe(client);
	expect(
		only(
			repo("apps/desktop/src-tauri/src/protocol.rs"),
			/pub const ZERO_SOCKET_PATH: &str = "([^"]*)";/g,
			"desktop",
		),
	).toBe(client);
});

test("native inbound limits admit Zero's largest binary poke chunk", () => {
	const chunk = Number(
		only(
			read(`${zeroRoot}/out/zero-cache/src/types/poke-chunk.js`),
			/POKE_CHUNK_BYTES = (\d+);/g,
			"Zero poke chunk",
		),
	);
	expect(chunk).toBeGreaterThan(0);
	const android = product(
		only(
			repo(
				"apps/android/android/app/src/main/java/io/ditero/app/NativeZeroTransport.java",
			),
			/static final int MAX_BINARY = ([\d *]+);/g,
			"Android",
		),
	);
	const desktop = product(
		only(
			repo("apps/desktop/src-tauri/src/protocol.rs"),
			/pub const MAX_SEND: usize = ([\d *]+);/g,
			"desktop",
		),
	);
	expect(android).toBeGreaterThanOrEqual(chunk);
	expect(desktop).toBeGreaterThanOrEqual(chunk);
});
