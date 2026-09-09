// The `e instanceof Error ? e.message : m.fallback()` idiom renders a bare
// English mutator/network string to the user, untranslated and LTR-shaped, on
// the COMMON path -- the translated key only covered the rare non-Error case.
// Route rejections through mutationErrorMessage instead.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// auth-messages.ts falls back to Better Auth's prose deliberately; its own
// header explains why losing the reason is worse than losing the language.
// lib/e2e/kdf-worker.ts crosses a worker boundary, not a render boundary:
// structured clone erases the Error subclass, so the string is copied across
// purely so console.error on the page still says what failed. Every UI path
// branches on the `failure` discriminant beside it and renders a translated
// key -- verified: no e2e component reads KdfError.message.
const ALLOWED = new Set(["lib/auth-messages.ts", "lib/e2e/kdf-worker.ts"]);
const LEAK = /instanceof Error \? \w+\.message/;

test("no component renders a raw Error message to the user", () => {
	const root = fileURLToPath(new URL(".", import.meta.url));
	const offenders: string[] = [];
	for (const entry of readdirSync(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
		if (/\.test\.tsx?$/.test(entry.name)) continue;
		const path = join(entry.parentPath, entry.name);
		const rel = relative(root, path).split(sep).join("/");
		if (ALLOWED.has(rel)) continue;
		const source = readFileSync(path, "utf8");
		source.split("\n").forEach((line, i) => {
			if (LEAK.test(line)) offenders.push(`${rel}:${i + 1}`);
		});
	}
	expect(offenders).toEqual([]);
});
