import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { vendorLicenses } from "../../scripts/vendor-licenses.ts";
export default defineConfig({
	plugins: [vendorLicenses(), react(), tailwindcss()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("../../src/web", import.meta.url)) },
	},
	build: { outDir: "dist", emptyOutDir: true },
});
