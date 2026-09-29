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

// Directional glyphs (BackButton, the calendar month pair) mirror only because
// `rtl:` resolves against the `dir` attribute applyDocumentLocale() writes onto
// <html>. A variant that compiled to `:dir(rtl)` alone would still be
// well-formed and would still leave every chevron pointing the wrong way.
test("rtl: resolves against the dir attribute, not only :dir()", async () => {
	const css = await build(["rtl:rotate-180"]);
	expect(css).toContain('[dir="rtl"]');
	expect(css).toContain("rotate: 180deg");
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

// `font-sans` must resolve Arabic glyphs to the self-hosted companion face
// before falling back to the platform sans -- dropping it from the stack
// reintroduces the mixed-typeface regression from #357 silently, since the
// page still renders and every Latin surface still looks fine.
test("font-sans keeps the Arabic companion face in the stack", async () => {
	const css = await build(["font-sans"]);
	expect(css).toContain(
		'font-family: "Geist Variable", "Noto Sans Arabic Variable", sans-serif;',
	);
	// The companion face must stay scoped to the Arabic block via unicode-range,
	// or it ships to every visitor instead of loading lazily for Arabic text.
	expect(css).toMatch(
		/font-family:\s*"Noto Sans Arabic Variable";[^}]*unicode-range:\s*U\+0?600/,
	);
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

// Every class the primitive's source could emit, compiled for real: a stock
// transition-all animates width/height/padding on any state change, and a
// blurred overlay is decoration the calm scrim replaced. Scanning the compiled
// CSS, not the markup, also catches a variant that reintroduces either.
function candidatesOf(file: string): string[] {
	const src = readFileSync(
		path.join(root, "src/web/components/ui", file),
		"utf8",
	);
	return [...new Set(src.split(/[\s"'`]+/).filter(Boolean))];
}

test("button, badge and tabs never transition layout properties", async () => {
	for (const file of ["button.tsx", "badge.tsx", "tabs.tsx"]) {
		const css = await build(candidatesOf(file));
		expect(css, file).toMatch(
			/transition-property:\s*color,\s*background-color/,
		);
		expect(css, file).not.toMatch(/transition-property:\s*all/);
	}
});

test("overlays use the scrim token and no backdrop blur", async () => {
	for (const file of ["dialog.tsx", "sheet.tsx", "alert-dialog.tsx"]) {
		const css = await build(candidatesOf(file));
		expect(css, file).toContain("background-color: var(--scrim)");
		expect(css, file).not.toContain("--tw-backdrop-blur:");
	}
});

// Sticky and floating bars sit on a solid surface (DESIGN.md No Glass Rule).
test("bottom nav, focus timer and board columns never blur", async () => {
	for (const file of [
		"../shell/BottomNav.tsx",
		"../focus/FocusTimer.tsx",
		"../views/BoardLayout.tsx",
	]) {
		const css = await build(candidatesOf(file));
		expect(css, file).not.toContain("--tw-backdrop-blur:");
		expect(css, file).not.toContain("backdrop-filter:");
	}
});

// The checkbox's priority tones and the warning token are only real if their
// utilities resolve to declared tokens; an undeclared --color-* emits nothing.
test("priority, warning and control tokens back their utilities", async () => {
	const css = await build([
		...candidatesOf("checkbox.tsx"),
		"text-warning",
		"border-warning/40",
	]);
	for (const token of [
		"--priority-1",
		"--priority-2",
		"--priority-3",
		"--control-border",
		"--warning",
	])
		expect(css).toContain(`var(${token})`);
	expect(css).toContain('[data-state="checked"]');
});
