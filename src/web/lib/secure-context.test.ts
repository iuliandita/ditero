import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// crypto.randomUUID, crypto.subtle and navigator.clipboard are gated to secure
// contexts, so none of them exist on the plain-HTTP LAN origin a self-hoster
// first reaches the app on. No test can catch a reintroduction: Playwright
// drives localhost, and every 127.0.0.0/8 address is trustworthy too, so the
// browser suite runs in a secure context by construction. This grep is the
// guard instead.
const ROOTS = ["src/web", "src/zero"];
const ALLOWED = new Set([
	// The fallbacks themselves, and this file naming the patterns.
	join("src", "web", "lib", "clipboard.ts"),
	join("src", "web", "lib", "secure-context.test.ts"),
]);
const BANNED: Array<{ pattern: RegExp; use: string }> = [
	{ pattern: /crypto\.randomUUID/, use: "randomId() from domain/random-id.ts" },
	{
		pattern: /navigator\.clipboard/,
		use: "copyText() from web/lib/clipboard.ts",
	},
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry) ? [path] : [];
	});
}

describe("secure-context APIs", () => {
	const files = ROOTS.flatMap(sourceFiles);

	it("finds the client sources it is meant to guard", () => {
		// Without this the sweep below passes for free if a path ever moves.
		expect(files.length).toBeGreaterThan(50);
	});

	it.each(BANNED)("routes $pattern through a fallback", ({ pattern, use }) => {
		const offenders = files.filter(
			(file) => !ALLOWED.has(file) && pattern.test(readFileSync(file, "utf8")),
		);
		expect(offenders, `use ${use} instead`).toEqual([]);
	});
});
