import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { expect, test, vi } from "vitest";
import { createDiteroMcp, mcpConfiguration } from "../mcp/server.ts";
import { runCli } from "./index.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const requestId = "00000000-0000-4000-8000-000000000001";
const completion = {
	listId: "list",
	expectedDueAt: "2026-10-04T12:00:00.000Z",
};
const task = {
	listId: "list",
	title: "Task",
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	assigneeIds: [],
	labelIds: [],
};
const message =
	"The request conflicts with the current task state or an existing request ID.";
const conflicts = [
	{
		code: "stale-completion",
		command: "complete-task",
		name: "complete_task",
		body: completion,
	},
	{
		code: "activation-pending",
		command: "complete-task",
		name: "complete_task",
		body: completion,
	},
	{
		code: "request-conflict",
		command: "create-task",
		name: "create_task",
		body: task,
	},
] as const;

test.each(
	conflicts,
)("CLI $code conflict is accurate and makes one POST", async ({
	code,
	command,
	body,
}) => {
	const fetcher = vi.fn(
		async (_url: URL, _init: RequestInit) =>
			new Response(
				JSON.stringify({ error: { code, message: env.DITERO_TOKEN } }),
				{ status: 409 },
			),
	);
	const stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		[
			command,
			...(command === "complete-task" ? ["--task", "task"] : []),
			"--request-id",
			requestId,
			"--json",
		],
		env,
		{ stdout, stderr },
		fetcher,
		async () => new TextEncoder().encode(JSON.stringify(body)),
	);
	expect(exit).toBe(10);
	expect(stdout).not.toHaveBeenCalled();
	expect(JSON.parse(stderr.mock.calls[0][0])).toEqual({
		version: 1,
		error: { code: "request_conflict", status: 409, message },
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][1]).toMatchObject({
		method: "POST",
		headers: { "idempotency-key": requestId },
		body: JSON.stringify(body),
	});
});

test.each(
	conflicts,
)("MCP $code conflict is accurate and makes one POST", async ({
	code,
	name,
	body,
}) => {
	const fetcher = vi.fn(
		async (_url: URL, _init: RequestInit) =>
			new Response(
				JSON.stringify({ error: { code, message: env.DITERO_TOKEN } }),
				{ status: 409 },
			),
	);
	const client = new Client(
		{ name: "conflict-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: serverTransport },
	);
	try {
		await client.connect(clientTransport);
		const result = await client.callTool({
			name,
			arguments:
				name === "complete_task"
					? { taskId: "task", requestId, completion: body }
					: { requestId, task: body },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			version: 1,
			error: { code: "request_conflict", status: 409, message },
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0][1]).toMatchObject({
			method: "POST",
			headers: { "idempotency-key": requestId },
			body: JSON.stringify(body),
		});
	} finally {
		await client.close();
		await handle.close();
	}
});
