import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import { type Fetcher, MAX_RESPONSE_BYTES } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const secret = `ditero_whk_${"B".repeat(43)}`;
const env = { DITERO_URL: "https://todo.example.test", DITERO_TOKEN: token };
const id = "11111111-1111-4111-8111-111111111111";
const metadata = {
	id,
	name: "Inbox",
	hint: "BBBB",
	listId: "list",
	workspaceId: "workspace",
	createdAt: "2026-10-05T00:00:00.000Z",
	expiresAt: "2027-01-03T00:00:00.000Z",
	revokedAt: null,
};
const created = { ...metadata, secret };
const webhook = { name: "Inbox", listId: "list" };
const envelope = (data: unknown, status = 200) =>
	Response.json({ version: 1, data, nextCursor: null }, { status });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "ditero-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: serverTransport },
	);
	cleanup.push(async () => {
		await client.close();
		await handle.close();
	});
	await client.connect(clientTransport);
	return client;
}
async function failed(
	client: Client,
	params: Parameters<Client["callTool"]>[0],
) {
	let message: string;
	try {
		const result = await client.callTool(params);
		if (result.isError !== true) return false;
		message = JSON.stringify(result.content);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	// A rejection must come from argument validation, not an unrelated failure.
	expect(message).toMatch(/invalid|validation/i);
	return true;
}

test("webhook tools describe the one-time secret and carry accurate annotations", async () => {
	const { tools } = await (await protocol(vi.fn())).listTools();
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	expect(byName.list_webhooks.annotations).toMatchObject({
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
	});
	expect(byName.create_webhook.annotations).toMatchObject({
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	});
	expect(byName.revoke_webhook.annotations).toMatchObject({
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	});
	expect(byName.create_webhook.description).toMatch(/one-time/);
	expect(byName.create_webhook.description).toMatch(/client's context/);
	expect(byName.create_webhook.inputSchema.required).toEqual(
		expect.arrayContaining(["revealSecret", "webhook"]),
	);
	expect(byName.create_webhook.inputSchema.properties).toMatchObject({
		revealSecret: { const: true },
	});
});

test("list_webhooks sends one plain GET and returns metadata only", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope([metadata]));
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name: "list_webhooks",
		arguments: {},
	});
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual({
		version: 1,
		data: [metadata],
		nextCursor: null,
	});
	expect(JSON.stringify(result)).not.toContain(secret);
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks`);
	expect(init.method).toBe("GET");
	expect(JSON.stringify(init.headers)).not.toContain("idempotency");
	for (const arguments_ of [{ limit: 1 }, { cursor: "abc" }, { listId: "l" }])
		expect(
			await failed(client, { name: "list_webhooks", arguments: arguments_ }),
		).toBe(true);
	expect(fetcher).toHaveBeenCalledOnce();
});

test("create_webhook requires literal revealSecret true and makes no request otherwise", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope(created, 201));
	const client = await protocol(fetcher);
	for (const arguments_ of [
		{ webhook },
		{ revealSecret: false, webhook },
		{ revealSecret: "true", webhook },
		{ revealSecret: true, webhook: { ...webhook, extra: 1 } },
		{ revealSecret: true, webhook: { ...webhook, expiresInDays: 366 } },
		{ revealSecret: true, webhook: { name: "", listId: "list" } },
		{ revealSecret: true, webhook: { ...webhook, name: "x".repeat(81) } },
		{ revealSecret: true, webhook, requestId: id },
	])
		expect(
			await failed(client, { name: "create_webhook", arguments: arguments_ }),
		).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});

test("create_webhook sends one POST without idempotency and returns the secret only in its result", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope(created, 201));
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual({
		version: 1,
		data: created,
		nextCursor: null,
	});
	expect(result.content).toEqual([
		{ type: "text", text: JSON.stringify(result.structuredContent) },
	]);
	expect(fetcher).toHaveBeenCalledOnce();
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks`);
	expect(init.method).toBe("POST");
	expect(JSON.parse(String(init.body))).toEqual({
		...webhook,
		expiresInDays: 90,
	});
	expect(JSON.stringify(init.headers)).not.toContain("idempotency");
});

test.each([
	["name", { ...created, name: "Other" }],
	["list", { ...created, listId: "other" }],
	["secret", metadata],
])("create_webhook rejects a response with mismatched %s without exposing a secret", async (_, data) => {
	const client = await protocol(
		vi.fn<Fetcher>(async () => envelope(data, 201)),
	);
	const result = await client.callTool({
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code: "invalid_response" },
	});
	expect(JSON.stringify(result)).not.toContain(secret);
});

test.each([
	[409, "webhook_limit"],
	[503, "temporarily_unavailable"],
	[403, "forbidden"],
	[401, "unauthorized"],
])("create_webhook maps %i and never echoes the server body", async (status, code) => {
	const client = await protocol(
		vi.fn<Fetcher>(async () => new Response(secret, { status })),
	);
	const result = await client.callTool({
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({ error: { code, status } });
	expect(JSON.stringify(result)).not.toContain(secret);
});

const uncertainAdvice =
	/may have been created.*List webhooks and revoke any unexpected one/;
const jsonHeaders = { "content-type": "application/json" };

test.each<[string, () => Promise<Response>, string]>([
	[
		"fetch rejection",
		async () => {
			throw new Error(`connect failed ${secret} ${token}`);
		},
		"network_error",
	],
	[
		"unreadable body",
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						throw new Error(`stream failed ${secret} ${token}`);
					},
				}),
				{ status: 201, headers: jsonHeaders },
			),
		"network_error",
	],
	[
		"non-JSON content type",
		async () =>
			new Response(JSON.stringify(created), {
				status: 201,
				headers: { "content-type": "text/plain" },
			}),
		"invalid_response",
	],
	[
		"unparseable JSON",
		async () => new Response("{", { status: 201, headers: jsonHeaders }),
		"invalid_response",
	],
	[
		"declared oversize body",
		async () =>
			new Response("{}", {
				status: 201,
				headers: {
					...jsonHeaders,
					"content-length": String(MAX_RESPONSE_BYTES + 1),
				},
			}),
		"invalid_response",
	],
	[
		"streamed oversize body",
		async () =>
			new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
				status: 201,
				headers: jsonHeaders,
			}),
		"invalid_response",
	],
	[
		"redirected response",
		async () =>
			Object.defineProperty(envelope(created, 201), "redirected", {
				value: true,
			}),
		"invalid_response",
	],
])("create_webhook gives list-and-revoke advice after one request on %s", async (_, respond, code) => {
	const fetcher = vi.fn<Fetcher>(respond);
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(fetcher).toHaveBeenCalledOnce();
	expect(fetcher.mock.calls[0][1].redirect).toBe("error");
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code, status: null },
	});
	const { error } = result.structuredContent as { error: { message: string } };
	expect(error.message).toMatch(uncertainAdvice);
	expect(JSON.stringify(result)).not.toMatch(
		/ditero_whk_|ditero_pat_|stream failed|connect failed/,
	);
});

test("create_webhook keeps definite status errors free of creation advice", async () => {
	for (const status of [400, 401, 403, 404, 409, 429]) {
		const fetcher = vi.fn<Fetcher>(
			async () => new Response(secret, { status }),
		);
		const result = await (await protocol(fetcher)).callTool({
			name: "create_webhook",
			arguments: { revealSecret: true, webhook },
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(/may have been created/);
		expect(fetcher).toHaveBeenCalledOnce();
	}
});

test("SDK cancellation reaches the active create_webhook HTTP signal without a second request", async () => {
	let entered!: () => void, stopped!: () => void;
	const started = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		aborted = new Promise<void>((resolve) => {
			stopped = resolve;
		});
	const fetcher = vi.fn<Fetcher>(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener(
					"abort",
					() => {
						stopped();
						reject(new Error("cancelled"));
					},
					{ once: true },
				);
				entered();
			}),
	);
	const client = await protocol(fetcher),
		controller = new AbortController();
	const pending = client
		.callTool(
			{
				name: "create_webhook",
				arguments: { revealSecret: true, webhook },
			},
			{ signal: controller.signal },
		)
		.catch((error: unknown) => error);
	await started;
	controller.abort();
	await aborted;
	await pending;
	expect(fetcher).toHaveBeenCalledOnce();
});

test("revoke_webhook sends one DELETE with a strict matching UUID", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope({ id, revoked: true }));
	const client = await protocol(fetcher);
	for (const arguments_ of [
		{},
		{ webhookId: "hook" },
		{ webhookId: id, extra: true },
		{ webhookId: `${id}/x` },
	])
		expect(
			await failed(client, { name: "revoke_webhook", arguments: arguments_ }),
		).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
	const result = await client.callTool({
		name: "revoke_webhook",
		arguments: { webhookId: id.toUpperCase() },
	});
	expect(result.structuredContent).toEqual({
		version: 1,
		data: { id, revoked: true },
		nextCursor: null,
	});
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks/${id}`);
	expect(init.method).toBe("DELETE");
	expect(init.body).toBeUndefined();
	expect(JSON.stringify(init.headers)).not.toContain("idempotency");
});

test("revoke_webhook rejects a mismatched acknowledgement", async () => {
	const client = await protocol(
		vi.fn<Fetcher>(async () =>
			envelope({ id: "22222222-2222-4222-8222-222222222222", revoked: true }),
		),
	);
	const result = await client.callTool({
		name: "revoke_webhook",
		arguments: { webhookId: id },
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code: "invalid_response" },
	});
});

test.each([
	500, 502, 503, 504,
])("create_webhook treats %i as uncertain without retry", async (status) => {
	const fetcher = vi.fn<Fetcher>(async () => new Response(secret, { status }));
	const result = await (await protocol(fetcher)).callTool({
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(fetcher).toHaveBeenCalledOnce();
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: {
			code: status === 503 ? "temporarily_unavailable" : "http_error",
			status,
		},
	});
	expect(
		(result.structuredContent as { error: { message: string } }).error.message,
	).toMatch(uncertainAdvice);
	expect(JSON.stringify(result)).not.toContain(secret);
});
