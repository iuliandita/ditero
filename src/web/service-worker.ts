/// <reference lib="webworker" />
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
declare const __PWA_FILES__: string[];
declare const __PWA_VERSION__: string;
const files: string[] =
	typeof __PWA_FILES__ === "undefined" ? [] : __PWA_FILES__;
const cacheName =
	"ditero-public-shell-" +
	(typeof __PWA_VERSION__ === "undefined" ? "test" : __PWA_VERSION__);
const cachePrefix = "ditero-public-shell-";

export function isPublicNavigation(url: URL): boolean {
	return url.pathname === "/" && url.search === "";
}

export async function navigationResponse(
	request: Request,
	network: () => Promise<Response>,
	shell: () => Promise<Response | undefined>,
): Promise<Response> {
	try {
		// HTTP failures are meaningful responses, never an offline signal.
		return await network();
	} catch (error) {
		if (isPublicNavigation(new URL(request.url))) {
			const cached = await shell();
			if (cached) return cached;
		}
		throw error;
	}
}

if (typeof worker.skipWaiting === "function") {
	worker.addEventListener("install", (event) => {
		event.waitUntil(
			(async () => {
				const cache = await caches.open(cacheName);
				try {
					for (const path of files) {
						const response = await fetch(path, {
							credentials: "omit",
							cache: "reload",
							redirect: "error",
						});
						if (!response.ok || response.type === "opaque")
							throw new Error("Public shell fetch failed");
						const type = response.headers.get("content-type") ?? "";
						if (path !== "/index.html" && type.includes("text/html"))
							throw new Error("Unexpected shell asset response");
						await cache.put(path, response);
					}
				} catch (error) {
					await caches.delete(cacheName);
					throw error;
				}
			})(),
		);
	});
	worker.addEventListener("activate", (event) => {
		event.waitUntil(
			(async () => {
				// Retain one previous build for tabs whose loaded shell is still old.
				const previous = (await caches.keys()).filter(
					(name) => name.startsWith(cachePrefix) && name !== cacheName,
				);
				for (const name of previous.slice(0, -1)) await caches.delete(name);
				await worker.clients.claim();
			})(),
		);
	});
	worker.addEventListener("message", (event) => {
		if (event.data?.type === "ACTIVATE_UPDATE")
			event.waitUntil(worker.skipWaiting());
	});
	worker.addEventListener("fetch", (event) => {
		const request = event.request;
		const url = new URL(request.url);
		if (request.method !== "GET" || url.origin !== worker.location.origin)
			return;
		if (request.mode === "navigate") {
			if (!isPublicNavigation(url)) return;
			event.respondWith(
				navigationResponse(
					request,
					() => fetch(request),
					async () => (await caches.open(cacheName)).match("/index.html"),
				),
			);
			return;
		}
		// Only fingerprinted build assets or the explicit public installation files.
		if (
			url.search ||
			(!files.includes(url.pathname) &&
				!/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(url.pathname))
		)
			return;
		event.respondWith(
			(async () => {
				const names = (await caches.keys()).filter((name) =>
					name.startsWith(cachePrefix),
				);
				for (const name of [
					cacheName,
					...names.filter((name) => name !== cacheName),
				]) {
					const response = await (await caches.open(name)).match(request);
					if (response) return response;
				}
				return fetch(request);
			})(),
		);
	});
}
