import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { discover, requestJson } from "./client.ts";
import { taskWorkflow } from "./task-workflow.ts";

const environment = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
function options(command = "workspaces") {
	const result = parseArguments([command, "--all"], environment);
	if (!result) throw new Error("Expected options");
	return result;
}
test("pre-cancelled reads and writes make no authenticated requests", async () => {
	const controller = new AbortController();
	controller.abort(new Error(environment.DITERO_TOKEN));
	const fetcher = vi.fn();
	await expect(
		requestJson(
			options(),
			new URL(environment.DITERO_URL),
			fetcher,
			undefined,
			undefined,
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled", exitCode: 7 });
	await expect(
		taskWorkflow(
			{
				...options(),
				command: "create-task",
				requestId: "82166f45-d2b6-45ac-9a3a-caa9d63c1b70",
			},
			fetcher,
			async () =>
				new TextEncoder().encode(
					JSON.stringify({ listId: "list", title: "Task" }),
				),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).not.toHaveBeenCalled();
});
test("cancellation interrupts a pending response stream and closes it", async () => {
	const controller = new AbortController();
	let cancelled = false;
	let began: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const stream = new ReadableStream<Uint8Array>({
		start(target) {
			target.enqueue(new TextEncoder().encode('{"version":1'));
		},
		pull() {
			began();
		},
		cancel() {
			cancelled = true;
		},
	});
	const fetcher = vi.fn(
		async () =>
			new Response(stream, { headers: { "content-type": "application/json" } }),
	);
	const pending = requestJson(
		options(),
		new URL(environment.DITERO_URL),
		fetcher,
		undefined,
		undefined,
		controller.signal,
	);
	await started;
	controller.abort(new Error(environment.DITERO_TOKEN));
	await expect(pending).rejects.toMatchObject({
		code: "cancelled",
		message: "The request was cancelled.",
	});
	expect(cancelled).toBe(true);
	expect(fetcher.mock.calls).toHaveLength(1);
});
test("an aborted scope stops discovery before another page", async () => {
	const controller = new AbortController();
	let count = 0;
	const fetcher = vi.fn(async () => {
		count++;
		controller.abort();
		return Response.json({
			version: 1,
			data: [
				{
					id: "workspace",
					name: "Home",
					kind: "shared",
					ownerId: "owner",
					role: "member",
				},
			],
			nextCursor: "next",
		});
	});
	await expect(
		discover(options(), fetcher, undefined, controller.signal),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(count).toBe(1);
});
test("caller cancellation reaches the fixed-origin fetch signal without leaking its reason", async () => {
	const controller = new AbortController();
	let began: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const pending = requestJson(
		options(),
		new URL(environment.DITERO_URL),
		async (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init.signal;
				if (!signal) throw new Error("Expected signal");
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
				began();
			}),
		undefined,
		undefined,
		controller.signal,
	);
	await started;
	controller.abort(new Error(environment.DITERO_TOKEN));
	await expect(pending).rejects.toMatchObject({
		code: "cancelled",
		message: "The request was cancelled.",
	});
});
