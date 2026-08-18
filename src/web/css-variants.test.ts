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
