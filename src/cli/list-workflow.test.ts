import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import type { Fetcher } from "./client.ts";
import { runCli } from "./index.ts";
import { encodeListInput, listWorkflow } from "./list-workflow.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const env = { DITERO_URL: "https://todo.example.test", DITERO_TOKEN: token };
const key = "00000000-0000-4000-8000-000000000001";
const list = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "Original",
	kind: "shopping",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const create = {
	workspaceId: "workspace",
	title: "Original",
	kind: "shopping",
};
const update = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	patch: { title: "Edited" },
};
const observation = { snapshot: list, stateToken: "a".repeat(64) };
const envelope = (data: unknown, status = 200) =>
	Response.json({ version: 1, data, nextCursor: null }, { status });
function options(command: string) {
	const value = parseArguments(
		[
			command,
			...(command === "create-list" ? [] : ["--list", "list"]),
			...(command === "observe-list" ? [] : ["--request-id", key]),
		],
		env,
	);
	if (!value) throw new Error("Missing options");
	return value;
}
async function run(
	raw: unknown,
	fetcher = vi.fn<Fetcher>(async () =>
		envelope({ kind: "list-create-ack", snapshot: list }),
	),
) {
	const stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		["create-list", "--request-id", key, "--json"],
		env,
		{ stdout, stderr },
		fetcher,
		async () => (raw instanceof Uint8Array ? raw : encodeListInput(raw)),
	);
	return { exit, stdout, stderr, fetcher };
}
test.each([
	200, 201,
])("create uses one canonical bounded POST with explicit UUID and immutable ack: %s", async (status) => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.href).toBe(`${env.DITERO_URL}/api/v1/lists`);
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			credentials: "omit",
			headers: { "idempotency-key": key, authorization: `Bearer ${token}` },
		});
		expect(JSON.parse(String(init.body))).toEqual({ ...create, icon: null });
		return envelope({ kind: "list-create-ack", snapshot: list }, status);
	});
	const result = await run({ ...create, title: " Original " }, fetcher);
	expect(result.exit).toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0]).data).toEqual({
		kind: "list-create-ack",
		snapshot: list,
	});
});
test("observe reads no stdin and validates matching ID; update sends no hidden GET", async () => {
	const reader = vi.fn();
	const observe = vi.fn(async () => envelope(observation));
	expect(await listWorkflow(options("observe-list"), observe, reader)).toEqual({
		version: 1,
		data: observation,
		nextCursor: null,
	});
	expect(reader).not.toHaveBeenCalled();
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/lists/list");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(String(init.body))).toEqual(update);
		return envelope({
			kind: "list-update-ack",
			snapshot: { ...list, title: "Edited" },
		});
	});
	await listWorkflow(options("update-list"), fetcher, async () =>
		encodeListInput(update),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	new Uint8Array([255]),
	new Uint8Array(4097),
	new TextEncoder().encode("{}{}"),
	{ ...create, folderId: null },
	{ ...create, title: "bad\0" },
	JSON.parse(
		'{"workspaceId":"workspace","title":"Original","kind":"tasks","constructor":{}}',
	),
])("invalid stdin produces no network or partial output %j", async (raw) => {
	const result = await run(raw);
	expect(result.exit).toBe(2);
	expect(result.fetcher).not.toHaveBeenCalled();
	expect(result.stdout).not.toHaveBeenCalled();
});
test("descriptor safety refuses inherited and getter inputs without invoking getters", () => {
	let called = false;
	const value = Object.defineProperty({ ...create }, "title", {
		enumerable: true,
		get() {
			called = true;
			return "Original";
		},
	});
	expect(() => encodeListInput(value)).toThrow();
	expect(called).toBe(false);
	expect(() =>
		encodeListInput({
			...create,
			toJSON() {
				called = true;
				return create;
			},
		}),
	).toThrow();
	expect(called).toBe(false);
	expect(() =>
		encodeListInput(Object.assign(Object.create({}), create)),
	).toThrow();
});
test.each([
	401, 403, 409,
])("status%s has safe stable error with no retry", async (status) => {
	const result = await run(
		create,
		vi.fn(async () => new Response(token, { status })),
	);
	expect(result.exit).toBe(status === 401 ? 3 : status === 403 ? 4 : 10);
	expect(result.fetcher).toHaveBeenCalledTimes(1);
	expect(result.stdout).not.toHaveBeenCalled();
	expect(result.stderr.mock.calls[0][0]).not.toContain(token);
	if (status === 409)
		expect(result.stderr.mock.calls[0][0]).not.toContain("task state");
});
test.each([
	{ kind: "list-create-ack", snapshot: { ...list, workspaceId: "other" } },
	{ kind: "list-update-ack", snapshot: list },
	{ kind: "list-create-ack", snapshot: { ...list, extra: true } },
])("rejects malformed/mismatched acknowledgements %j", async (data) => {
	const result = await run(
		create,
		vi.fn(async () => envelope(data)),
	);
	expect(result.exit).toBe(8);
	expect(result.stdout).not.toHaveBeenCalled();
});
test("rejects mismatched observation/update IDs", async () => {
	for (const command of ["observe-list", "update-list"]) {
		await expect(
			listWorkflow(
				options(command),
				async () =>
					envelope(
						command === "observe-list"
							? { ...observation, snapshot: { ...list, id: "other" } }
							: { kind: "list-update-ack", snapshot: { ...list, id: "other" } },
					),
				async () => encodeListInput(update),
			),
		).rejects.toMatchObject({ code: "invalid_response" });
	}
});
test("caller cancellation aborts a blocked body and never retries", async () => {
	const controller = new AbortController();
	let bodyStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		bodyStarted = resolve;
	});
	const cancel = vi.fn();
	const fetcher = vi.fn(
		async () =>
			new Response(
				new ReadableStream({
					start() {
						bodyStarted();
					},
					cancel,
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const pending = listWorkflow(
		options("observe-list"),
		fetcher,
		vi.fn(),
		controller.signal,
	);
	await started;
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("real CLI stdin refuses oversized input, redirects, lost responses and preserves exact manual retry", async () => {
	const requests: { method: string; url: string; key: string; body: string }[] =
		[];
	let mode = "lost";
	const api = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({
			method: request.method ?? "",
			url: request.url ?? "",
			key: String(request.headers["idempotency-key"]),
			body,
		});
		if (mode === "lost") {
			response.destroy();
			return;
		}
		if (mode === "redirect") {
			response.writeHead(302, {
				location: "https://other.example.test/private",
			});
			response.end(token);
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				version: 1,
				data: { kind: "list-create-ack", snapshot: list },
				nextCursor: null,
			}),
		);
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const address = api.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	async function binary(raw: Uint8Array | unknown) {
		const child = spawn(
			"bun",
			[
				"run",
				fileURLToPath(new URL("./index.ts", import.meta.url)),
				"create-list",
				"--request-id",
				key,
				"--json",
				"--allow-loopback-http",
			],
			{
				env: {
					...process.env,
					DITERO_URL: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
					DITERO_TOKEN: token,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (b) => {
			stdout += b;
		});
		child.stderr.on("data", (b) => {
			stderr += b;
		});
		child.stdin.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code !== "EPIPE") throw e;
		});
		child.stdin.end(raw instanceof Uint8Array ? raw : JSON.stringify(raw));
		const exit = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return { exit, stdout, stderr };
	}
	try {
		for (const raw of [new Uint8Array([255]), new Uint8Array(4097)])
			expect((await binary(raw)).exit).toBe(2);
		expect(requests).toHaveLength(0);
		const failed = await binary(create);
		expect(failed.exit).toBe(7);
		expect(failed.stdout).toBe("");
		mode = "normal";
		expect((await binary(create)).exit).toBe(0);
		expect(requests[0]).toEqual(requests[1]);
		mode = "redirect";
		const redirected = await binary(create);
		expect(redirected.exit).toBe(7);
		expect(redirected.stdout + redirected.stderr).not.toContain(token);
		expect(requests).toHaveLength(3);
	} finally {
		api.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			api.close((e) => (e ? reject(e) : resolve())),
		);
	}
}, 15000);

test.each([
	["observe-list", "."],
	["observe-list", ".."],
	["update-list", "."],
	["update-list", ".."],
])("dot-segment list IDs fail before HTTP in CLI %s %s", async (command, listId) => {
	const fetcher = vi.fn(async () =>
		envelope({ kind: "list-update-ack", snapshot: list }),
	);
	const stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		[
			command,
			"--list",
			listId,
			...(command === "update-list" ? ["--request-id", key] : []),
			"--json",
		],
		env,
		{ stdout, stderr },
		fetcher,
		async () => encodeListInput(update),
	);
	expect(exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
	expect(stdout).not.toHaveBeenCalled();
	expect(JSON.parse(stderr.mock.calls[0][0]).error.code).toBe("invalid_input");
});
test.each([
	".hidden",
	"list..",
	"%2e",
	"opaque/list",
])("other opaque list IDs retain addressing %s", async (listId) => {
	const fetcher = vi.fn(async (url: URL) => {
		expect(url.pathname).toBe(
			`/api/v1/lists/${encodeURIComponent(listId)}/observation`,
		);
		return envelope({ ...observation, snapshot: { ...list, id: listId } });
	});
	await listWorkflow({ ...options("observe-list"), listId }, fetcher, vi.fn());
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
	"folder",
	null,
])("placement uses one PATCH and the exact original key: %j", async (folderId) => {
	const body = { ...update, patch: { folderId, sortKey: "a0abc123" } };
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/lists/list");
		expect(init.method).toBe("PATCH");
		expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(
			key,
		);
		expect(JSON.parse(String(init.body))).toEqual(body);
		return envelope({
			kind: "list-update-ack",
			snapshot: { ...list, folderId, sortKey: "a0abc123" },
		});
	});
	await listWorkflow(options("update-list"), fetcher, async () =>
		encodeListInput(body),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	{ folderId: "" },
	{ sortKey: "a00" },
	{ sortKey: "a0!" },
	{ sortKey: `a0${"1".repeat(255)}` },
])("invalid placement produces no CLI request %j", async (patch) => {
	const fetcher = vi.fn();
	await expect(
		listWorkflow(options("update-list"), fetcher, async () =>
			encodeListInput({ ...update, patch }),
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
