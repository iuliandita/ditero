import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig } from "vite";
import { paraglideOptions } from "./paraglide.options.ts";
import { configureSignupTransport } from "./scripts/e2e-signup-transport.ts";
import { apiProxyTarget } from "./scripts/e2e-stack.ts";
import { vendorLicenses } from "./scripts/vendor-licenses.ts";

const testEntries = {
	"e2e-download": "./src/web/lib/e2e/download.ts",
	"e2e-ciphertext-staging": "./src/web/lib/e2e/ciphertext-staging.ts",
	"e2e-zero-lifecycle": "./src/web/lib/zero-lifecycle.ts",
	"e2e-zero-close-browser": "./tests/e2e/zero-close-browser.ts",
	"e2e-csp-gate": "./src/web/dev/csp-gate.ts",
	"e2e-stream": "./src/domain/e2e/stream.ts",
	"e2e-envelope": "./src/domain/e2e/envelope.ts",
	"e2e-wire": "./src/domain/e2e/wire.ts",
};
const testRoutes = new Set(
	Object.values(testEntries).map((path) => path.slice(1)),
);
export default defineConfig(({ mode }) => ({
	build:
		mode === "test"
			? {
					rolldownOptions: {
						input: {
							index: fileURLToPath(new URL("./index.html", import.meta.url)),
							...Object.fromEntries(
								Object.entries(testEntries).map(([name, path]) => [
									name,
									fileURLToPath(new URL(path, import.meta.url)),
								]),
							),
						},
						preserveEntrySignatures: "strict",
						output: {
							entryFileNames: (chunk) =>
								Object.hasOwn(testEntries, chunk.name)
									? testEntries[chunk.name as keyof typeof testEntries].slice(2)
									: "assets/[name]-[hash].js",
						},
					},
				}
			: undefined,
	plugins: [
		{
			name: "e2e-compiled-module-entries",
			apply: "serve",
			configurePreviewServer(server) {
				if (mode !== "test") return;
				server.middlewares.use((request, _response, next) => {
					if (
						(request.method === "GET" || request.method === "HEAD") &&
						testRoutes.has(request.url ?? "")
					)
						_response.setHeader(
							"Content-Type",
							"text/javascript; charset=utf-8",
						);
					next();
				});
			},
		},
		vendorLicenses(),
		{
			name: "e2e-fresh-http-connections",
			apply: "serve",
			configurePreviewServer(server) {
				if (
					process.env.NODE_ENV !== "test" ||
					process.env.DITERO_E2E_SIGNUP_TRANSPORT !== "1"
				)
					return;
				server.middlewares.use((request, response, next) => {
					const path = request.url?.split("?", 1)[0];
					if (path === "/api" || path?.startsWith("/api/"))
						response.setHeader("Connection", "close");
					next();
				});
			},
			configureServer(server) {
				if (
					process.env.NODE_ENV !== "test" ||
					process.env.DITERO_E2E_SIGNUP_TRANSPORT !== "1"
				)
					return;
				// Setup requests must not inherit an earlier response's idle socket.
				server.middlewares.use((request, response, next) => {
					const path = request.url?.split("?", 1)[0];
					if (path === "/api" || path?.startsWith("/api/"))
						response.setHeader("Connection", "close");
					next();
				});
			},
		},
		{
			name: "public-pwa-shell",
			apply: "build",
			generateBundle(_options, bundle) {
				const assets = Object.values(bundle).filter((item) =>
					item.fileName.startsWith("assets/"),
				);
				const bytes = assets.reduce(
					(sum, item) =>
						sum +
						(item.type === "chunk"
							? Buffer.byteLength(item.code)
							: typeof item.source === "string"
								? Buffer.byteLength(item.source)
								: item.source.length),
					0,
				);
				if (assets.length > 512 || bytes > 64 * 1024 * 1024)
					throw new Error("PWA public shell exceeds cache budget");
				const files = [
					"/index.html",
					"/manifest.webmanifest",
					"/icon-192.png",
					"/icon-512.png",
					...assets.map((item) => `/${item.fileName}`),
				].sort();
				const version = createHash("sha256")
					.update(JSON.stringify(files))
					.update(readFileSync("index.html"))
					.update(readFileSync("public/manifest.webmanifest"))
					.update(readFileSync("public/icon-192.png"))
					.update(readFileSync("public/icon-512.png"))
					.update(readFileSync("src/web/service-worker.ts"))
					.digest("hex")
					.slice(0, 20);
				const source = ts
					.transpileModule(readFileSync("src/web/service-worker.ts", "utf8"), {
						compilerOptions: {
							target: ts.ScriptTarget.ES2022,
							module: ts.ModuleKind.ESNext,
						},
					})
					.outputText.replaceAll("__PWA_FILES__", JSON.stringify(files))
					.replaceAll("__PWA_VERSION__", JSON.stringify(version));
				this.emitFile({ type: "asset", fileName: "sw.js", source });
			},
		},
		react(),
		tailwindcss(),
		paraglideVitePlugin({ ...paraglideOptions }),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
	},
	optimizeDeps: { entries: ["index.html"] },
	server: {
		watch: { ignored: ["**/docs/local/**"] },
		proxy: {
			"/api": {
				target: apiProxyTarget(process.env),
				changeOrigin: true,
				configure:
					process.env.NODE_ENV === "test" &&
					process.env.DITERO_E2E_SIGNUP_TRANSPORT === "1"
						? configureSignupTransport
						: undefined,
			},
		},
	},
}));
