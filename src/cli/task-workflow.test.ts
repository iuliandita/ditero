import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import type { Fetcher } from "./client.ts";
import { MAX_RESPONSE_BYTES } from "./client.ts";
import { runCli } from "./index.ts";
import { MAX_INPUT_BYTES } from "./task-workflow.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const env = { DITERO_URL: "https://todo.example.test", DITERO_TOKEN: token };
const requestId = "00000000-0000-4000-8000-000000000001";
const profile = {
	id: "me",
	name: "Me",
	timezone: "Europe/Berlin",
	timezoneChosen: true,
	locale: "en",
	serverTime: "2026-10-24T10:00:00Z",
	tokenAccess: "write",
};
const workspace = {
	id: "private",
	name: "Private",
	kind: "personal",
	ownerId: "me",
	role: "owner",
};
const list = {
	id: "inbox",
	workspaceId: "private",
	ownerId: "me",
	title: "Inbox",
	kind: "tasks",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const person = {
	id: "alex",
	name: "Alex",
	image: null,
	workspaceIds: ["private"],
};
const task = {
	id: "saved",
	listId: "inbox",
	workspaceId: "private",
	title: "Authoritative coffee",
	done: false,
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey: "a1",
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: null,
	recurrenceRelative: false,
	reminderTime: null,
	assigneeIds: [],
	labelIds: [],
};
const intent = {
	title: "Buy coffee",
	target: { kind: "list", selector: { name: "Inbox" }, personal: true },
	due: { day: "tomorrow" },
	assignees: [{ name: "Alex" }],
};
const create = { listId: "inbox", title: "Buy coffee" };
const envelope = (
	data: unknown,
	nextCursor: string | null = null,
	status = 200,
) => Response.json({ version: 1, data, nextCursor }, { status });
const snapshot: Record<string, unknown> = {
	me: profile,
	workspaces: [workspace],
	lists: [list],
	people: [person],
	labels: [],
	views: [],
	dashboards: [],
};
function run(command: string[], raw: unknown, fetcher: Fetcher) {
	const stdout = vi.fn();
	const stderr = vi.fn();
	return runCli(
		[...command, "--json"],
		env,
		{ stdout, stderr },
		fetcher,
		async () =>
			raw instanceof Uint8Array
				? raw
				: new TextEncoder().encode(JSON.stringify(raw)),
	).then((exit) => ({ exit, stdout, stderr }));
}

test("planning gathers every page sequentially before resolving tomorrow and emits no writes", async () => {
	const paths: string[] = [];
	const result = await run(["plan-task"], intent, async (url, init) => {
		expect(init.method).toBe("GET");
		paths.push(url.pathname);
		const resource = url.pathname.split("/").at(-1) ?? "";
		if (resource === "lists")
			return url.searchParams.has("cursor")
				? envelope([list])
				: envelope([], "list_next");
		return envelope(snapshot[resource]);
	});
	expect(result.exit).toBe(0);
	expect(result.stderr).not.toHaveBeenCalled();
	expect(JSON.parse(result.stdout.mock.calls[0][0])).toMatchObject({
		version: 1,
		target: { kind: "list", id: "inbox" },
		timezone: "Europe/Berlin",
		resolvedAt: profile.serverTime,
		task: {
			listId: "inbox",
			dueAt: "2026-10-25T11:00:00.000Z",
			assigneeIds: ["alex"],
		},
	});
	expect(paths).toEqual([
		"/api/v1/me",
		"/api/v1/workspaces",
		"/api/v1/lists",
		"/api/v1/lists",
		"/api/v1/people",
		"/api/v1/labels",
		"/api/v1/views",
		"/api/v1/dashboards",
	]);
});

test("ambiguity exposes only authorized choices and never posts", async () => {
	const result = await run(["plan-task"], intent, async (url, init) => {
		expect(init.method).toBe("GET");
		const resource = url.pathname.split("/").at(-1) ?? "";
		return envelope(
			resource === "people"
				? [person, { ...person, id: "alex-two" }]
				: snapshot[resource],
		);
	});
	expect(result.exit).toBe(2);
	expect(result.stdout).not.toHaveBeenCalled();
	expect(JSON.parse(result.stderr.mock.calls[0][0]).error).toMatchObject({
		code: "ambiguous-assignee",
		choices: [
			{ id: "alex", name: "Alex" },
			{ id: "alex-two", name: "Alex" },
		],
	});
});

test.each([
	"missing-view",
	"failed-page",
])("planning refuses incomplete context atomically: %s", async (failure) => {
	const result = await run(
		["plan-task"],
		{ ...intent, target: { kind: "dashboard", selector: { id: "home" } } },
		async (url) => {
			const resource = url.pathname.split("/").at(-1) ?? "";
			if (resource === "views" && failure === "failed-page")
				return new Response(token, { status: 503 });
			if (resource === "dashboards")
				return envelope([
					{
						id: "home",
						ownerId: "me",
						workspaceId: null,
						scope: "personal",
						name: "Home",
						icon: null,
						panels: [
							{
								id: "panel",
								type: "tasks",
								size: "full",
								source: { kind: "view", viewId: "missing" },
							},
						],
					},
				]);
			return envelope(snapshot[resource]);
		},
	);
	expect(result.exit).toBe(failure === "failed-page" ? 9 : 2);
	expect(result.stdout).not.toHaveBeenCalled();
	expect(result.stderr.mock.calls[0][0]).not.toContain(token);
	if (failure === "missing-view")
		expect(JSON.parse(result.stderr.mock.calls[0][0]).error.code).toBe(
			"dashboard-view-unavailable",
		);
});

test.each([
	new Uint8Array([0xff]),
	new Uint8Array(MAX_INPUT_BYTES + 1),
	new TextEncoder().encode('{"__proto__":{"x":1}}'),
	new TextEncoder().encode('{"title":"x","constructor":{}}'),
	new TextEncoder().encode(`${'{"x":'.repeat(34)}null${"}".repeat(34)}`),
	new TextEncoder().encode("{}{}"),
])("malformed or bounded stdin is rejected before requests", async (raw) => {
	const fetcher = vi.fn();
	const result = await run(["plan-task"], raw, fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
	expect(result.stdout).not.toHaveBeenCalled();
});

test.each([
	["create-task"],
	["create-task", "--request-id", "not-a-uuid"],
	["plan-task", "--request-id", requestId],
	["plan-task", "--all"],
	["create-task", "--request-id", requestId, "--file", "private.json"],
	["create-task", "--request-id", requestId, "--token", token],
])("workflow flags reject unsupported input: %j", async (...argv: string[]) => {
	const fetcher = vi.fn();
	const result = await run(argv, create, fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
	expect(result.stderr.mock.calls[0][0]).not.toContain(token);
});

test.each([
	200, 201,
])("create preserves UUID and canonical input and returns authoritative task: %s", async (status) => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.href).toBe(`${env.DITERO_URL}/api/v1/tasks`);
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			credentials: "omit",
			headers: {
				"idempotency-key": requestId,
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			...create,
			notes: null,
			dueAt: null,
			dueAllDay: false,
			priority: 0,
			assigneeIds: [],
			labelIds: [],
		});
		return envelope(task, null, status);
	});
	const result = await run(
		["create-task", "--request-id", requestId],
		create,
		fetcher,
	);
	expect(result.exit).toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0]).data).toEqual(task);
});

test.each([
	[409, 10, "request_conflict"],
	[410, 11, "task_deleted"],
	[401, 3, "unauthorized"],
	[403, 4, "forbidden"],
])("create status %s has stable error/exit and no automatic retry", async (status, exit, code) => {
	const fetcher = vi.fn(
		async () => new Response(token, { status: Number(status) }),
	);
	const result = await run(
		["create-task", "--request-id", requestId],
		create,
		fetcher,
	);
	expect(result.exit).toBe(exit);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(result.stdout).not.toHaveBeenCalled();
	expect(JSON.parse(result.stderr.mock.calls[0][0]).error).toMatchObject({
		code,
		status,
	});
	expect(result.stderr.mock.calls[0][0]).not.toContain(token);
});

test("plan context shares one 20 MiB budget across all pages and resources", async () => {
	let requests = 0;
	const result = await run(["plan-task"], intent, async (url) => {
		requests++;
		if (url.pathname.endsWith("/me")) return envelope(profile);
		const text = JSON.stringify({
			version: 1,
			data: [],
			nextCursor: `page_${requests}`,
		});
		return new Response(text + " ".repeat(MAX_RESPONSE_BYTES - text.length), {
			headers: { "content-type": "application/json" },
		});
	});
	expect(result.exit).toBe(8);
	expect(requests).toBe(11);
	expect(result.stdout).not.toHaveBeenCalled();
});

test("real stdin subprocess plans and replays one explicit POST key without private output", async () => {
	const posts: { key: string; body: string }[] = [];
	let mode = "normal";
	let requests = 0;
	const api = createServer(async (request, response) => {
		requests++;
		expect(request.headers.authorization).toBe(`Bearer ${token}`);
		const url = new URL(request.url ?? "/", "http://localhost");
		response.setHeader("content-type", "application/json");
		if (mode === "auth") {
			response.statusCode = 401;
			response.end(token);
			return;
		}
		const resource = url.pathname.split("/").at(-1) ?? "";
		if (mode === "page-failure" && resource === "views") {
			response.statusCode = 503;
			response.end(token);
			return;
		}
		if (resource === "people" && mode === "ambiguity") {
			response.end(
				JSON.stringify({
					version: 1,
					data: [person, { ...person, id: "alex-two" }],
					nextCursor: null,
				}),
			);
			return;
		}
		if (resource === "lists" && !url.searchParams.has("cursor")) {
			response.end(
				JSON.stringify({ version: 1, data: [], nextCursor: "next_list" }),
			);
			return;
		}
		if (request.method === "POST") {
			let body = "";
			for await (const chunk of request) body += chunk;
			posts.push({ key: String(request.headers["idempotency-key"]), body });
			if (posts.length > 2) {
				response.statusCode = posts.length === 3 ? 409 : 410;
				response.end(token);
				return;
			}
			response.statusCode = posts.length === 1 ? 201 : 200;
			response.end(
				JSON.stringify({ version: 1, data: task, nextCursor: null }),
			);
		} else
			response.end(
				JSON.stringify({
					version: 1,
					data: snapshot[url.pathname.split("/").at(-1) ?? ""],
					nextCursor: null,
				}),
			);
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const address = api.address();
	if (!address || typeof address === "string")
		throw new Error("Owned port unavailable");
	async function binary(argv: string[], raw: unknown) {
		const child = spawn(
			"bun",
			[
				"run",
				fileURLToPath(new URL("./index.ts", import.meta.url)),
				...argv,
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
		child.stdout.on("data", (bytes) => {
			stdout += bytes;
		});
		child.stderr.on("data", (bytes) => {
			stderr += bytes;
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") throw error;
		});
		child.stdin.end(raw instanceof Uint8Array ? raw : JSON.stringify(raw));
		const exit = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return { exit, stdout, stderr };
	}
	try {
		for (const bytes of [
			new Uint8Array([0xff]),
			new Uint8Array(MAX_INPUT_BYTES + 1),
		]) {
			const rejected = await binary(["plan-task"], bytes);
			expect(rejected.exit).toBe(2);
			expect(rejected.stdout).toBe("");
		}
		expect(requests).toBe(0);
		for (const [failure, exit, code] of [
			["ambiguity", 2, "ambiguous-assignee"],
			["page-failure", 9, "http_error"],
			["auth", 3, "unauthorized"],
		] as const) {
			mode = failure;
			const rejected = await binary(["plan-task"], intent);
			expect(rejected.exit).toBe(exit);
			expect(rejected.stdout).toBe("");
			expect(JSON.parse(rejected.stderr).error.code).toBe(code);
			expect(rejected.stderr).not.toContain(token);
			expect(posts).toHaveLength(0);
		}
		mode = "normal";
		const planned = await binary(["plan-task"], intent);
		expect(planned.exit).toBe(0);
		expect(posts).toHaveLength(0);
		const raw = JSON.parse(planned.stdout).task;
		for (const exit of [0, 0, 10, 11]) {
			const result = await binary(
				["create-task", "--request-id", requestId],
				raw,
			);
			expect(result.exit).toBe(exit);
			expect(result.stdout + result.stderr).not.toContain(token);
			if (exit === 0) expect(JSON.parse(result.stdout).data).toEqual(task);
			else expect(result.stdout).toBe("");
		}
		expect(posts.map((post) => post.key)).toEqual(Array(4).fill(requestId));
		expect(new Set(posts.map((post) => post.body)).size).toBe(1);
	} finally {
		await new Promise<void>((resolve, reject) =>
			api.close((error) => (error ? reject(error) : resolve())),
		);
	}
}, 15_000);
