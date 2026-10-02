import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { ClientRequest, createServer, type Server } from "node:http";
import {
	createConnection,
	createServer as createNetServer,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, type Page, request } from "@playwright/test";
import {
	createServer as createViteServer,
	type Plugin,
	type ProxyOptions,
} from "vite";
import { afterEach, expect, test, vi } from "vitest";
import { signUp } from "../tests/e2e/helpers.ts";

const project = vi.hoisted(() => ({ baseURL: "", ui: {} }));
vi.mock("@playwright/test", async (original) => {
	const actual = await original<typeof import("@playwright/test")>();
	return {
		...actual,
		test: { info: () => ({ project: { use: project } }) },
		// UI readiness is outside this transport contract; retain real response assertions.
		expect: (value: unknown, message?: string) =>
			value === project.ui
				? { toBeVisible: async () => {}, toHaveAttribute: async () => {} }
				: actual.expect(value, message),
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function listen(server: Server | ReturnType<typeof createNetServer>) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture address");
	return address.port;
}

async function socks() {
	const sockets = new Set<Socket>();
	const server = createNetServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => {});
		let pending = Buffer.alloc(0);
		let greeted = false;
		const input = (data: Buffer) => {
			pending = Buffer.concat([pending, data]);
			if (!greeted) {
				if (pending.length < 2 || pending.length < 2 + pending[1]) return;
				if (pending[0] !== 5) return client.destroy();
				pending = pending.subarray(2 + pending[1]);
				client.write(Buffer.from([5, 0]));
				greeted = true;
			}
			if (pending.length < 5) return;
			const offset = pending[3] === 3 ? 5 : 4;
			const length = pending[3] === 3 ? pending[4] : pending[3] === 1 ? 4 : -1;
			if (length < 0 || pending[1] !== 1) return client.destroy();
			if (pending.length < offset + length + 2) return;
			const host =
				pending[3] === 3
					? pending.subarray(offset, offset + length).toString()
					: [...pending.subarray(offset, offset + length)].join(".");
			if (host !== "127.0.0.1" && host !== "localhost") return client.destroy();
			const port = pending.readUInt16BE(offset + length);
			pending = pending.subarray(offset + length + 2);
			client.removeListener("data", input);
			const upstream = createConnection({ host: "127.0.0.1", port }, () => {
				client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
				if (pending.length) upstream.write(pending);
				client.pipe(upstream);
				upstream.pipe(client);
			});
			sockets.add(upstream);
			upstream.on("close", () => sockets.delete(upstream));
			upstream.on("error", (error) => client.destroy(error));
			client.on("close", () => upstream.destroy());
		};
		client.on("data", input);
	});
	const port = await listen(server);
	return {
		url: `socks5://127.0.0.1:${port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function fixture(nodeEnv = "test", enabled = true) {
	vi.stubEnv("NODE_ENV", nodeEnv);
	vi.stubEnv("DITERO_E2E_SIGNUP_TRANSPORT", enabled ? "1" : "0");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.resetModules();
	const { default: config } = await import("../vite.config.ts");
	const directory = await mkdtemp(join(tmpdir(), "signup-connection-"));
	const accepted: string[] = [];
	let interrupt = false;
	const upstream = createServer((request, response) => {
		request.resume();
		if (request.url === "/api/auth/sign-up/email") {
			accepted.push(request.url);
			if (interrupt) {
				request.socket.end();
				return;
			}
			response.setHeader(
				"Set-Cookie",
				"fixture-session=accepted; Path=/; HttpOnly; SameSite=Lax",
			);
		}
		response.setHeader("Connection", "keep-alive");
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ user: { id: "fixture-user" } }));
	});
	const upstreamPort = await listen(upstream);
	const history = new WeakMap<Socket, number>();
	const signupPriorRequests: number[] = [];
	let priorPeer: Socket | undefined;
	const observed = new Set<Socket>();
	const observer: Plugin = {
		name: "disposable-signup-fixture",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				observed.add(request.socket);
				const prior = history.get(request.socket) ?? 0;
				history.set(request.socket, prior + 1);
				if (request.url === "/api/prime") priorPeer = request.socket;
				if (request.url === "/api/auth/sign-up/email")
					signupPriorRequests.push(prior);
				if (request.url === "/") {
					response.setHeader("Content-Type", "text/html");
					response.end(
						`<div data-testid="workspace">${request.headers.cookie ?? ""}</div><div data-testid="workspace-switcher" data-workspace-id="fixture-workspace"></div>`,
					);
				} else if (request.url === "/api/fixture-error") {
					response.statusCode = 503;
					response.end("fixture unavailable");
				} else if (request.url === "/fixture-module.js") {
					response.setHeader("Content-Type", "application/javascript");
					response.end(`export const priorRequests = ${prior};`);
				} else next();
			});
		},
	};
	const proxy = config.server?.proxy?.["/api"] as ProxyOptions;
	// Retain the real connection plugin/proxy configuration; omit unrelated app transforms.
	const plugins = (config.plugins as Plugin[]).filter(
		(plugin) => plugin.name === "e2e-fresh-http-connections",
	);
	const vite = await createViteServer({
		configFile: false,
		root: directory,
		plugins: [...plugins, observer],
		server: {
			host: "127.0.0.1",
			port: 0,
			strictPort: true,
			hmr: false,
			watch: null,
			proxy: {
				"/api": { ...proxy, target: `http://127.0.0.1:${upstreamPort}` },
			},
		},
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	await vite.listen();
	const address = vite.httpServer?.address();
	if (!address || typeof address === "string")
		throw new Error("Missing Vite fixture address");
	const origin = `http://127.0.0.1:${address.port}`;
	project.baseURL = origin;
	return {
		origin,
		accepted,
		signupPriorRequests,
		interrupt() {
			interrupt = true;
		},
		priorPeer: () => priorPeer,
		async close() {
			for (const socket of observed) socket.destroy();
			await vite.close();
			upstream.closeAllConnections();
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function context(proxy?: string): Promise<APIRequestContext> {
	return request.newContext(proxy ? { proxy: { server: proxy } } : {});
}

function page(context: APIRequestContext): Page {
	return {
		request: context,
		goto: async (url: string) => {
			await context.get(url);
		},
		getByTestId: () => project.ui,
	} as unknown as Page;
}

test.each([
	"direct",
	"socks",
])("the real signup helper uses fresh %s connections after API GETs for every user", async (mode) => {
	const server = await fixture();
	const proxy = mode === "socks" ? await socks() : undefined;
	try {
		for (const role of ["owner", "member", "viewer", "outsider"]) {
			const ctx = await context(proxy?.url);
			try {
				const signupPage = page(ctx);
				const prime = await ctx.get(`${server.origin}/api/prime`);
				expect(prime.headers().connection).toBe("close");
				expect(await signUp(signupPage, `${role}@example.test`)).toBe(
					"fixture-user",
				);
				expect((await ctx.storageState()).cookies).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: "fixture-session",
							value: "accepted",
							httpOnly: true,
						}),
					]),
				);
			} finally {
				await ctx.dispose();
			}
		}
		expect(server.accepted).toHaveLength(4);
		expect(server.signupPriorRequests).toEqual([0, 0, 0, 0]);
	} finally {
		await proxy?.close();
		await server.close();
	}
}, 20_000);

test("an interrupted fresh signup fails once without masking its transport error", async () => {
	const server = await fixture();
	const ctx = await context();
	try {
		server.interrupt();
		await expect(signUp(page(ctx), "interrupted@example.test")).rejects.toThrow(
			"signup failed with status 502",
		);
		expect(server.accepted).toHaveLength(1);
		expect(server.signupPriorRequests).toEqual([0]);
	} finally {
		await ctx.dispose();
		await server.close();
	}
});

test.each([
	["test", false],
	["development", true],
	["production", true],
] as const)(
	"the disabled gate (%s/%s) exposes the pooled FIN control",
	async (environment, enabled) => {
		const server = await fixture(environment, enabled);
		const ctx = await context();
		let reused = false;
		let forced = false;
		const closePriorPeer = (event: unknown) => {
			if (
				!event ||
				typeof event !== "object" ||
				!("request" in event) ||
				!(event.request instanceof ClientRequest)
			)
				return;
			const { request } = event;
			if (
				request.getHeader("Origin") !== server.origin ||
				request.method !== "POST"
			)
				return;
			reused = request.reusedSocket;
			const peer = server.priorPeer();
			if (peer && !peer.destroyed) {
				peer.pause();
				peer.end();
				forced = true;
			}
		};
		try {
			const signupPage = page(ctx);
			const prime = await ctx.get(`${server.origin}/api/prime`);
			expect(prime.headers().connection).toBe("keep-alive");
			channel("http.client.request.start").subscribe(closePriorPeer);
			await expect(signUp(signupPage, "control@example.test")).rejects.toThrow(
				"socket hang up",
			);
			expect(reused).toBe(true);
			expect(forced).toBe(true);
			expect(server.accepted).toEqual([]);
		} finally {
			channel("http.client.request.start").unsubscribe(closePriorPeer);
			await ctx.dispose();
			await server.close();
		}
	},
	20_000,
);

test("the early middleware closes API error responses", async () => {
	const server = await fixture();
	const ctx = await context();
	try {
		const response = await ctx.get(`${server.origin}/api/fixture-error`);
		expect(response.status()).toBe(503);
		expect(response.headers().connection).toBe("close");
	} finally {
		await ctx.dispose();
		await server.close();
	}
});

test("frontend documents and modules retain connection reuse", async () => {
	const server = await fixture();
	const ctx = await context();
	try {
		const document = await ctx.get(server.origin);
		expect(document.headers().connection).toBe("keep-alive");
		const module = await ctx.get(`${server.origin}/fixture-module.js`);
		expect(module.headers().connection).toBe("keep-alive");
		expect(await module.text()).toBe("export const priorRequests = 1;");
	} finally {
		await ctx.dispose();
		await server.close();
	}
});
