import { createAppCheckVerifier } from "./app-check.ts";
import { loadConfiguration } from "./configuration.ts";
import { createFcmSender } from "./fcm.ts";
import { prune } from "./prune.ts";
import { createRoutes } from "./routes.ts";
import { Store } from "./store.ts";

const configurationFile = process.env.RELAY_CONFIGURATION_FILE;
const databaseUrl = process.env.RELAY_DATABASE_URL;
if (!configurationFile || !databaseUrl)
	throw new Error(
		"RELAY_CONFIGURATION_FILE and RELAY_DATABASE_URL are required",
	);
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
	throw new Error("Invalid relay port");
const configuration = await loadConfiguration(configurationFile);
const store = new Store(databaseUrl);
await store.assertRuntimeAuthority();
const routes = createRoutes({
	store,
	configuration,
	appCheck: createAppCheckVerifier(configuration),
	send: createFcmSender(configuration),
});
const server = Bun.serve({
	hostname: "0.0.0.0",
	port,
	maxRequestBodySize: 16384,
	idleTimeout: 10,
	async fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/healthz")
			return Response.json(
				{ status: "ok" },
				{ headers: { "cache-control": "no-store" } },
			);
		if (request.method === "GET" && path === "/readyz") {
			const ready = await store.ready();
			return Response.json(
				{ status: ready ? "ready" : "unavailable" },
				{ status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
			);
		}
		return routes(request, server.requestIP(request)?.address ?? "unknown");
	},
});
let pruning = false;
const interval = setInterval(() => {
	if (pruning) return;
	pruning = true;
	void prune(store)
		.catch(() => {
			console.error("Relay retention sweep failed");
		})
		.finally(() => {
			pruning = false;
		});
}, 60000);
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	clearInterval(interval);
	await server.stop();
	await store.close();
}
process.on("SIGTERM", () => {
	void stop();
});
process.on("SIGINT", () => {
	void stop();
});
console.info("Push relay listening");
