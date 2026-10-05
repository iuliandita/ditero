import { expect, test, vi } from "vitest";
import { CliError, parseArguments } from "./arguments.ts";
import { type Fetcher, MAX_RESPONSE_BYTES } from "./client.ts";
import { runCli } from "./index.ts";
import { webhookWorkflow } from "./webhook-workflow.ts";

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
const input = { name: "Inbox", listId: "list" };
const envelope = (data: unknown, status = 200) =>
	Response.json({ version: 1, data, nextCursor: null }, { status });
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));

async function run(
	argv: string[],
	fetcher: Fetcher,
	stdin: Uint8Array = bytes(input),
) {
	const stdout = vi.fn<(text: string) => void>();
	const stderr = vi.fn<(text: string) => void>();
	const reader = vi.fn(async () => stdin);
	const exit = await runCli(
		[...argv, "--json"],
		env,
		{ stdout, stderr },
		fetcher,
		reader,
	);
	return {
		exit,
		reader,
		out: stdout.mock.calls.map(([text]) => text).join(""),
		err: stderr.mock.calls.map(([text]) => text).join(""),
	};
}
const unused = () => vi.fn<Fetcher>(async () => envelope(null));

test("list sends one plain GET without query, body or idempotency header", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope([metadata]));
	const { exit, out, err } = await run(["list-webhooks"], fetcher);
	expect(exit).toBe(0);
	expect(err).toBe("");
	expect(fetcher).toHaveBeenCalledOnce();
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks`);
	expect(init.method).toBe("GET");
	expect(init.body).toBeUndefined();
	expect(init.headers).toEqual({
		authorization: `Bearer ${token}`,
		accept: "application/json",
	});
	expect(JSON.parse(out)).toEqual({
		version: 1,
		data: [metadata],
		nextCursor: null,
	});
});

const rows = (count: number, expired: (index: number) => boolean) =>
	Array.from({ length: count }, (_, index) => ({
		...metadata,
		id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
		createdAt: expired(index) ? "2025-12-01T00:00:00.000Z" : metadata.createdAt,
		expiresAt: expired(index) ? "2026-01-01T00:00:00.000Z" : metadata.expiresAt,
	}));

test("list accepts 21 unrevoked rows when some have expired", async () => {
	const data = rows(21, (index) => index % 2 === 0);
	const { exit, out, err } = await run(
		["list-webhooks"],
		vi.fn<Fetcher>(async () => envelope(data)),
	);
	expect(exit).toBe(0);
	expect(err).toBe("");
	expect(JSON.parse(out)).toEqual({ version: 1, data, nextCursor: null });
});

test("list accepts exactly 100 rows and refuses 101", async () => {
	const accepted = await run(
		["list-webhooks"],
		vi.fn<Fetcher>(async () => envelope(rows(100, (index) => index > 0))),
	);
	expect(accepted.exit).toBe(0);
	const refused = await run(
		["list-webhooks"],
		vi.fn<Fetcher>(async () => envelope(rows(101, (index) => index > 0))),
	);
	expect(refused.exit).toBe(8);
	expect(refused.out).toBe("");
	expect(JSON.parse(refused.err).error.code).toBe("invalid_response");
});

test.each([
	["--limit", "10"],
	["--cursor", "abc"],
	["--workspace", "workspace"],
	["--list", "list"],
	["--done", "true"],
	["--request-id", id],
	["--webhook", id],
	["--task", "task"],
])("list rejects %s before any request", async (flag, value) => {
	const fetcher = unused();
	const result = await run(["list-webhooks", flag, value], fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});

test("list rejects --all and --reveal-secret, and other commands reject webhook flags", () => {
	for (const argv of [
		["list-webhooks", "--all"],
		["list-webhooks", "--reveal-secret"],
		["revoke-webhook", "--webhook", id, "--reveal-secret"],
		["create-webhook", "--all", "--reveal-secret"],
		["create-webhook", "--webhook", id, "--reveal-secret"],
		["lists", "--reveal-secret"],
		["tasks", "--webhook", id],
	])
		expect(() => parseArguments(argv, env)).toThrow();
});

test("list refuses secrets or unknown fields in rows", async () => {
	const result = await run(
		["list-webhooks"],
		vi.fn<Fetcher>(async () => envelope([created])),
	);
	expect(result.exit).toBe(8);
	expect(result.out).toBe("");
	expect(result.err).not.toContain(secret);
});

test("create requires an explicit reveal flag before reading input or sending", async () => {
	const fetcher = unused();
	const result = await run(["create-webhook"], fetcher);
	expect(result.exit).toBe(2);
	expect(JSON.parse(result.err).error.code).toBe("reveal_required");
	expect(result.reader).not.toHaveBeenCalled();
	expect(fetcher).not.toHaveBeenCalled();
});

test.each([
	["empty", new Uint8Array()],
	["invalid JSON", new TextEncoder().encode("{")],
	["array", bytes([input])],
	["missing list", bytes({ name: "Inbox" })],
	["blank name", bytes({ ...input, name: "  " })],
	["long name", bytes({ ...input, name: "x".repeat(81) })],
	["control name", bytes({ ...input, name: "a\u0000b" })],
	["zero lifetime", bytes({ ...input, expiresInDays: 0 })],
	["long lifetime", bytes({ ...input, expiresInDays: 366 })],
	["fractional lifetime", bytes({ ...input, expiresInDays: 1.5 })],
	["extra field", bytes({ ...input, secret: "x" })],
	["request id", bytes({ ...input, requestId: id })],
	["prototype key", new TextEncoder().encode('{"__proto__":{},"name":"a"}')],
	["oversized", bytes({ ...input, name: "x".repeat(5000) })],
])("create rejects %s input with zero requests", async (_, stdin) => {
	const fetcher = unused();
	const result = await run(
		["create-webhook", "--reveal-secret"],
		fetcher,
		stdin,
	);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
	expect(result.out).toBe("");
});

test("create sends one strict POST with defaults, no idempotency header, and prints the secret once", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope(created, 201));
	const { exit, out, err } = await run(
		["create-webhook", "--reveal-secret"],
		fetcher,
		bytes({ name: " Inbox ", listId: "list" }),
	);
	expect(exit).toBe(0);
	expect(err).toBe("");
	expect(fetcher).toHaveBeenCalledOnce();
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks`);
	expect(init.method).toBe("POST");
	expect(JSON.parse(String(init.body))).toEqual({
		name: "Inbox",
		listId: "list",
		expiresInDays: 90,
	});
	expect(init.headers).toEqual({
		authorization: `Bearer ${token}`,
		accept: "application/json",
		"content-type": "application/json",
	});
	expect(out.trim().split("\n")).toHaveLength(1);
	expect(JSON.parse(out)).toEqual({
		version: 1,
		data: created,
		nextCursor: null,
	});
});

test.each([
	["name", { ...created, name: "Other" }],
	["list", { ...created, listId: "other" }],
	["revoked", { ...created, revokedAt: "2026-10-05T00:00:00.000Z" }],
	["missing secret", metadata],
	["malformed secret", { ...created, secret: "ditero_whk_short" }],
	["extra field", { ...created, extra: true }],
])("create rejects a response with mismatched %s without echoing the secret", async (_, data) => {
	const result = await run(
		["create-webhook", "--reveal-secret"],
		vi.fn<Fetcher>(async () => envelope(data, 201)),
	);
	expect(result.exit).toBe(8);
	expect(result.out).toBe("");
	expect(result.err).not.toContain(secret);
	expect(JSON.parse(result.err).error.code).toBe("invalid_response");
});

test.each([
	[409, 10, "webhook_limit"],
	[503, 9, "temporarily_unavailable"],
	[401, 3, "unauthorized"],
	[403, 4, "forbidden"],
	[404, 5, "not_found"],
	[429, 6, "rate_limited"],
	[400, 2, "request_rejected"],
])("create maps %i without echoing server bodies", async (status, exit, code) => {
	const result = await run(
		["create-webhook", "--reveal-secret"],
		vi.fn<Fetcher>(
			async () =>
				new Response(JSON.stringify({ secret, token, detail: "private" }), {
					status,
				}),
		),
	);
	expect(result.exit).toBe(exit);
	expect(JSON.parse(result.err).error).toMatchObject({ code, status });
	expect(result.err).not.toMatch(/private|ditero_whk_|ditero_pat_|request ID/);
	if (status >= 500)
		expect(JSON.parse(result.err).error.message).toMatch(uncertainAdvice);
	else expect(result.err).not.toMatch(/may have been created/);
	expect(result.out).toBe("");
});

const uncertainAdvice =
	/may have been created.*List webhooks and revoke any unexpected one/;
const jsonHeaders = { "content-type": "application/json" };
const erroring = () =>
	new ReadableStream<Uint8Array>({
		pull() {
			throw new Error(`stream failed ${secret} ${token}`);
		},
	});
const redirected = () =>
	Object.defineProperty(envelope(created, 201), "redirected", { value: true });

test.each<[string, () => Promise<Response>, number, string]>([
	[
		"fetch rejection",
		async () => {
			throw new Error(`connect failed ${secret} ${token}`);
		},
		7,
		"network_error",
	],
	[
		"unreadable body",
		async () => new Response(erroring(), { status: 201, headers: jsonHeaders }),
		7,
		"network_error",
	],
	[
		"non-JSON content type",
		async () =>
			new Response(JSON.stringify(created), {
				status: 201,
				headers: { "content-type": "text/plain" },
			}),
		8,
		"invalid_response",
	],
	[
		"unparseable JSON",
		async () => new Response("{", { status: 201, headers: jsonHeaders }),
		8,
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
		8,
		"invalid_response",
	],
	[
		"streamed oversize body",
		async () =>
			new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
				status: 201,
				headers: jsonHeaders,
			}),
		8,
		"invalid_response",
	],
	["redirected response", async () => redirected(), 8, "invalid_response"],
])("create gives list-and-revoke advice after one request on %s", async (_, respond, exit, code) => {
	const fetcher = vi.fn<Fetcher>(respond);
	const result = await run(["create-webhook", "--reveal-secret"], fetcher);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(fetcher.mock.calls[0][1].redirect).toBe("error");
	expect(result.exit).toBe(exit);
	expect(result.out).toBe("");
	const error = JSON.parse(result.err).error;
	expect(error).toMatchObject({ code, status: null });
	expect(error.message).toMatch(uncertainAdvice);
	expect(result.err).not.toMatch(
		/ditero_whk_|ditero_pat_|stream failed|connect failed/,
	);
});

test("create gives the same advice when the caller cancels after sending", async () => {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const fetcher = vi.fn<Fetcher>(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener(
					"abort",
					() => reject(new Error(`aborted ${secret}`)),
					{ once: true },
				);
				entered();
			}),
	);
	const controller = new AbortController();
	const options = parseArguments(["create-webhook", "--reveal-secret"], env);
	if (!options) throw new Error("Expected options");
	const pending = webhookWorkflow(
		options,
		fetcher,
		async () => bytes(input),
		controller.signal,
	).catch((error: unknown) => error);
	await started;
	controller.abort();
	const error = await pending;
	expect(error).toBeInstanceOf(CliError);
	expect(error).toMatchObject({ code: "cancelled", exitCode: 7, status: null });
	expect((error as CliError).message).toMatch(uncertainAdvice);
	expect((error as CliError).message).not.toContain(secret);
	expect(fetcher).toHaveBeenCalledOnce();
});

test("create cancelled before sending sends nothing and gives no creation advice", async () => {
	const fetcher = unused();
	const options = parseArguments(["create-webhook", "--reveal-secret"], env);
	if (!options) throw new Error("Expected options");
	const error = await webhookWorkflow(
		options,
		fetcher,
		async () => bytes(input),
		AbortSignal.abort(),
	).catch((failure: unknown) => failure);
	expect(error).toMatchObject({ code: "cancelled", exitCode: 7 });
	expect((error as CliError).message).not.toMatch(/may have been created/);
	expect(fetcher).not.toHaveBeenCalled();
});

test("list and revoke keep generic messages for transport failures", async () => {
	for (const argv of [["list-webhooks"], ["revoke-webhook", "--webhook", id]]) {
		const fetcher = vi.fn<Fetcher>(async () => {
			throw new Error("down");
		});
		const result = await run(argv, fetcher);
		expect(result.exit).toBe(7);
		expect(JSON.parse(result.err).error.code).toBe("network_error");
		expect(result.err).not.toMatch(/may have been created/);
		expect(fetcher).toHaveBeenCalledOnce();
	}
});

test("revoke sends one DELETE with no body or idempotency header and normalizes the UUID", async () => {
	const fetcher = vi.fn<Fetcher>(async () => envelope({ id, revoked: true }));
	const { exit, out } = await run(
		["revoke-webhook", "--webhook", id.toUpperCase()],
		fetcher,
	);
	expect(exit).toBe(0);
	expect(fetcher).toHaveBeenCalledOnce();
	const [url, init] = fetcher.mock.calls[0];
	expect(url.href).toBe(`${env.DITERO_URL}/api/v1/webhooks/${id}`);
	expect(init.method).toBe("DELETE");
	expect(init.body).toBeUndefined();
	expect(init.headers).toEqual({
		authorization: `Bearer ${token}`,
		accept: "application/json",
	});
	expect(JSON.parse(out)).toEqual({
		version: 1,
		data: { id, revoked: true },
		nextCursor: null,
	});
});

test.each([
	[[]],
	[["--webhook", "not-a-uuid"]],
	[["--webhook", `${id}/../x`]],
	[["--webhook", id, "--request-id", id]],
	[["--webhook", id, "--limit", "1"]],
	[["--webhook", id, "--all"]],
])("revoke rejects arguments %j before any request", async (extra) => {
	const fetcher = unused();
	const result = await run(["revoke-webhook", ...extra], fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});

test.each([
	[
		"different id",
		{ id: "22222222-2222-4222-8222-222222222222", revoked: true },
	],
	["not revoked", { id, revoked: false }],
	["extra field", { id, revoked: true, secret }],
])("revoke rejects a response with %s", async (_, data) => {
	const result = await run(
		["revoke-webhook", "--webhook", id],
		vi.fn<Fetcher>(async () => envelope(data)),
	);
	expect(result.exit).toBe(8);
	expect(result.err).not.toContain(secret);
});

test.each([
	[404, 5, "not_found"],
	[403, 4, "forbidden"],
	[401, 3, "unauthorized"],
	[409, 9, "http_error"],
	[503, 9, "temporarily_unavailable"],
])("revoke maps %i independent of request-ID mappers", async (status, exit, code) => {
	const result = await run(
		["revoke-webhook", "--webhook", id],
		vi.fn<Fetcher>(async () => new Response(secret, { status })),
	);
	expect(result.exit).toBe(exit);
	expect(JSON.parse(result.err).error).toMatchObject({ code, status });
	expect(result.err).not.toMatch(/ditero_whk_|request ID|deleted/);
});

test("credentials are never accepted as flags", () => {
	for (const flag of ["--token", "--secret", "--pat"])
		expect(() => parseArguments(["list-webhooks", flag, token], env)).toThrow();
});

test.each([
	500, 502, 503, 504,
])("create treats %i as an uncertain outcome without retry", async (status) => {
	const fetcher = vi.fn<Fetcher>(async () => new Response(secret, { status }));
	const result = await run(["create-webhook", "--reveal-secret"], fetcher);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(result.exit).toBe(9);
	expect(result.out).toBe("");
	expect(JSON.parse(result.err).error).toMatchObject({
		code: status === 503 ? "temporarily_unavailable" : "http_error",
		status,
	});
	expect(JSON.parse(result.err).error.message).toMatch(uncertainAdvice);
	expect(result.err).not.toContain(secret);
});
