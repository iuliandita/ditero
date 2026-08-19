// motion/react cannot read a CSS custom property, so the FLIP transition holds a
// second copy of the base duration and easing. Nothing at runtime would notice
// the two frames disagreeing -- one surface would simply animate differently
// from the one next to it -- so the copy is pinned to index.css here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { MOTION_BASE_SEC, MOTION_EASE } from "./motion.ts";

const css = readFileSync(
	fileURLToPath(new URL("../index.css", import.meta.url)),
	"utf8",
);

function token(name: string): string {
	const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
	if (!match) throw new Error(`index.css no longer declares --${name}`);
	return match[1].trim();
}

test("the FLIP transition mirrors the --motion-base and --motion-ease tokens", () => {
	expect(token("motion-base")).toBe(`${MOTION_BASE_SEC * 1000}ms`);
	expect(token("motion-ease")).toBe(`cubic-bezier(${MOTION_EASE.join(", ")})`);
});
