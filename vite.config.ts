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
		}),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
	},
	server: { proxy: { "/api": "http://localhost:3000" } },
});
