import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { paraglideOptions } from "../../paraglide.options.ts";
import { vendorLicenses } from "../../scripts/vendor-licenses.ts";
export default defineConfig({
	plugins: [
		vendorLicenses(),
		react(),
		tailwindcss(),
		paraglideVitePlugin({
			...paraglideOptions,
			project: fileURLToPath(new URL("../../project.inlang", import.meta.url)),
			outdir: fileURLToPath(new URL("../../src/paraglide", import.meta.url)),
		}),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("../../src/web", import.meta.url)) },
	},
	build: { outDir: "dist", emptyOutDir: true },
});
