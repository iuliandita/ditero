import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { paraglideOptions } from "./paraglide.options.ts";
import { configureSignupTransport } from "./scripts/e2e-signup-transport.ts";
export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		paraglideVitePlugin({ ...paraglideOptions }),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
	},
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				changeOrigin: true,
				configure:
					process.env.NODE_ENV === "test" &&
					process.env.DITERO_E2E_SIGNUP_TRANSPORT === "1"
						? configureSignupTransport
						: undefined,
			},
		},
	},
});
