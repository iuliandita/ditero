import type { CompilerOptions } from "@inlang/paraglide-js";

// Single source of truth for every paraglide entry point: the Vite plugin
// (`vite dev`/`vite build`) and `bun run i18n:compile` (also run by
// `typecheck` and the e2e harness). Both write the same outdir, so any option
// that differs between them makes the last writer win.
//
// `outputStructure` is pinned because the Vite plugin otherwise picks it from
// NODE_ENV -- `locale-modules` in dev, `message-modules` in prod -- and the two
// produce disjoint file sets. Compiling with one after the other deletes the
// other's files, and a `bun run --hot` server re-imports mid-delete and dies
// with "Cannot find module './toggle_on.js'" (#53). `message-modules` is the
// production structure, so pinning it keeps the shipped bundle tree-shakeable
// and costs only dev compile time.
//
// `strategy` is here for the same reason: omitting it in either place silently
// drops localStorage persistence and preferredLanguage detection (#63).
export const paraglideOptions = {
	project: "./project.inlang",
	outdir: "./src/paraglide",
	emitTsDeclarations: true,
	outputStructure: "message-modules",
	strategy: ["cookie", "localStorage", "preferredLanguage", "baseLocale"],
} as const satisfies CompilerOptions;
