import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { paraglideOptions } from "../paraglide.options.ts";

const read = (path: string) => readFile(path, "utf8");
// These files explain the pin in prose; only executable lines are asserted on.
const code = async (path: string) =>
	(await read(path)).replace(/^\s*\/\/.*$/gm, "");

describe("paraglide compile options are pinned", () => {
	// The Vite plugin picks outputStructure from NODE_ENV when the option is
	// absent, so leaving it unset makes dev and CLI compiles write disjoint file
	// sets into the same outdir (#53).
	test("outputStructure is explicit", () => {
		expect(paraglideOptions.outputStructure).toBe("message-modules");
	});

	test("the strategy chain is explicit and ordered", () => {
		expect(paraglideOptions.strategy).toEqual([
			"cookie",
			"localStorage",
			"preferredLanguage",
			"baseLocale",
		]);
	});
});

// Every entry point must read the shared module. A second declaration would
// compile fine and drift silently, which is exactly how #53 and #63 happened.
describe("no entry point declares its own compile options", () => {
	test("vite.config.ts spreads the shared options", async () => {
		const src = await code("vite.config.ts");
		expect(src).toContain("paraglide.options.ts");
		expect(src).toContain("paraglideOptions");
		expect(src).not.toMatch(/outputStructure|strategy:/);
	});

	test("the compile script spreads the shared options", async () => {
		const src = await code("scripts/i18n-compile.ts");
		expect(src).toContain("paraglide.options.ts");
		expect(src).not.toMatch(/outputStructure|strategy:/);
	});

	test("the package script carries no compiler flags", async () => {
		const pkg = JSON.parse(await read("package.json"));
		expect(pkg.scripts["i18n:compile"]).toBe("bun run scripts/i18n-compile.ts");
	});

	test.each([
		"tests/e2e/run.ts",
		".github/workflows/ci.yml",
		".github/workflows/release.yml",
	])("%s compiles via the package script", async (path) => {
		const src = await read(path);
		expect(src).toContain("i18n:compile");
		expect(src).not.toContain("paraglide-js compile");
	});
});
