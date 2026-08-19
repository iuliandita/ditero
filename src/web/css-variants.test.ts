// The data-open:/data-closed: utilities across components/ui/* are only animated
// because a @custom-variant maps them onto Radix's data-state attribute. A
// missing or wrong declaration compiles to a selector that never matches, and
// nothing fails -- so the compiled selector is asserted directly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const req = createRequire(path.join(root, "package.json"));

function resolveCss(id: string, base: string): string {
	if (id.startsWith(".") || id.startsWith("/")) return path.resolve(base, id);
	try {
		const r = req.resolve(id);
		if (r.endsWith(".css")) return r;
	} catch {}
	try {
		const r = req.resolve(`${id}/index.css`);
		if (r.endsWith(".css")) return r;
	} catch {}
	const dir = path.join(root, "node_modules", id);
	const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
	return path.resolve(dir, pkg.style ?? pkg.exports?.["."]?.style ?? pkg.main);
}

async function build(candidates: string[]): Promise<string> {
	const base = path.join(root, "src/web");
	const compiler = await compile(
		readFileSync(path.join(base, "index.css"), "utf8"),
		{
			base,
			loadStylesheet: async (id, from) => {
				const file = resolveCss(id, from);
				return {
					path: file,
					base: path.dirname(file),
					content: readFileSync(file, "utf8"),
				};
			},
			loadModule: async () => {
				throw new Error("no js modules in this stylesheet");
			},
		},
	);
	return compiler.build(candidates);
}

test("data-open/data-closed compile onto Radix's data-state, not a bare attribute", async () => {
	const css = await build([
		"data-open:animate-in",
		"data-closed:animate-out",
		"data-[side=bottom]:data-open:slide-in-from-bottom-10",
	]);
	expect(css).toContain('[data-state="open"]');
	expect(css).toContain('[data-state="closed"]');
	// A selector that only tests the bare boolean attribute never matches Radix.
	expect(css).not.toMatch(/\{\s*&:?\s*\[data-open\]\s*\{/);
	expect(css).toContain("@keyframes enter");
	expect(css).toContain("@keyframes exit");
});

// A shadow-*/duration-*/ease-* utility naming a token that does not exist emits
// nothing at all -- the class stays in the markup and the elevation or timing
// silently disappears. Same failure shape as the variant test above.
test("the motion and elevation tokens back their utilities", async () => {
	const css = await build([
		"shadow-overlay",
		"shadow-floating",
		"duration-(--motion-fast)",
		"ease-(--motion-ease)",
	]);
	expect(css).toContain("--tw-shadow: var(--elevation-overlay)");
	expect(css).toContain("--tw-shadow: var(--elevation-floating)");
	expect(css).toContain("transition-duration: var(--motion-fast)");
	expect(css).toContain("transition-timing-function: var(--motion-ease)");
	// @theme inline drops its variables after inlining them, so the motion tokens
	// must reach :root as plain declarations or every var() above resolves to
	// nothing.
	for (const name of ["--motion-fast", "--motion-base", "--motion-slow"])
		expect(css).toContain(`${name}: `);
});

// Extracts the declaration block opened by `open`, balancing braces so a nested
// block (the media query's `:root:not(.light)`) does not end it early.
function blockAfter(css: string, open: string, from = 0): string {
	const start = css.indexOf(open, from);
	if (start === -1) throw new Error(`index.css no longer contains ${open}`);
	let depth = 0;
	for (let i = start + open.length - 1; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0)
			return css.slice(start + open.length, i);
	}
	throw new Error(`unbalanced braces after ${open}`);
}

function customProps(block: string): Set<string> {
	return new Set(block.match(/--[\w-]+(?=\s*:)/g) ?? []);
}

test("both dark palettes declare the same custom properties", () => {
	const css = readFileSync(path.join(root, "src/web/index.css"), "utf8");
	const darkAt = css.indexOf(".dark {");
	const classBlock = customProps(blockAfter(css, ".dark {"));
	// The @custom-variant at the top of the file opens an earlier
	// prefers-color-scheme block; the palette one follows .dark.
	const mediaBlock = customProps(
		blockAfter(
			blockAfter(css, "@media (prefers-color-scheme: dark) {", darkAt),
			":root:not(.light) {",
		),
	);
	// Guards the mirror comments on both blocks: a token added to one and not
	// the other silently ships light-mode values to OS-dark users.
	expect(classBlock.size).toBeGreaterThan(30);
	expect([...mediaBlock].sort()).toEqual([...classBlock].sort());
});
