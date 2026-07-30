import { compile } from "@inlang/paraglide-js";
import { paraglideOptions } from "../paraglide.options.ts";

// Replaces a `paraglide-js compile` CLI line so the flags cannot drift from the
// Vite plugin's options; both read paraglide.options.ts. See that file for why
// outputStructure and strategy must match.
await compile(paraglideOptions);
