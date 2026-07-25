import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			emitTsDeclarations: true,
			// Must mirror the `i18n:compile` script: both write this outdir, and the
			// plugin wins for `vite dev`/`vite build`. Without it the shipped bundle
			// falls back to paraglide's default chain and loses localStorage
			// persistence and preferredLanguage detection.
			strategy: ["cookie", "localStorage", "preferredLanguage", "baseLocale"],
		}),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
	},
	server: { proxy: { "/api": "http://localhost:3000" } },
});
