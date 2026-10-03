import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const args = {
	taskId: "task",
	requestId: "00000000-0000-4000-8000-000000000001",
	completion: { listId: "list", expectedDueAt: null },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "completion-test", version: "1" },
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
test("completion advertises inspected observations and honest mutation/retry annotations", async () => {
	const client = await protocol(vi.fn());
	const tool = (await client.listTools()).tools.find(
		(tool) => tool.name === "complete_task",
	);
	expect(tool?.annotations).toMatchObject({
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	});
	expect(tool?.inputSchema.additionalProperties).toBe(false);
	expect(tool?.outputSchema?.additionalProperties).toBe(false);
	expect(tool?.description).toContain("previously observed");
	expect(tool?.description).toContain("Recurring");
	expect(tool?.description).toContain("identical completion body and key");
});
test.each([
	{ ...args, server: env.DITERO_URL },
	{ ...args, requestId: "invalid" },
	{ ...args, taskId: "" },
	{ ...args, completion: { listId: "list" } },
	{ ...args, completion: { ...args.completion, expectedDueAt: "tomorrow" } },
	{ ...args, completion: { ...args.completion, done: true } },
	{
		...args,
		completion: JSON.parse(
			'{"listId":"list","expectedDueAt":null,"__proto__":{}}',
		),
	},
])("completion guards invalid input before transport", async (arguments_) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name: "complete_task", arguments: arguments_ }))
				.isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test("completion preserves conflict/deletion/uncertain errors without discovery or retries", async () => {
	for (const status of [409, 410, 401, 403]) {
		const fetcher = vi.fn(
			async () => new Response(env.DITERO_TOKEN, { status }),
		);
		const client = await protocol(fetcher);
		const result = await client.callTool({
			name: "complete_task",
			arguments: args,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: { status } });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(result)).not.toContain(env.DITERO_TOKEN);
	}
});
