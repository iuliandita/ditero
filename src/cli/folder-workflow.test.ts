import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { type CliOptions, parseArguments } from "./arguments.ts";
import {
	encodeFolderWorkflowInput,
	folderWorkflow,
} from "./folder-workflow.ts";
import { runCli } from "./index.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const snapshot = {
	id: "folder",
	workspaceId: "ws",
	name: "Projects",
	sortKey: "a0",
};
const observation = { snapshot, stateToken: "a".repeat(64) };
const create = { workspaceId: "ws", name: "Projects" };
const update = {
	workspaceId: "ws",
	expectedState: observation.stateToken,
	patch: { name: "Renamed" },
};
const deletion = { workspaceId: "ws", expectedState: observation.stateToken };
function options(command: CliOptions["command"]): CliOptions {
	const parsed = parseArguments(["folders"], env);
	if (!parsed) throw new Error("Missing parsed configuration");
	return {
		...parsed,
		command,
		folderId: "folder",
		requestId: key,
	};
}
const envelope = (data: unknown, status = 200) =>
	Response.json({ version: 1, data, nextCursor: null }, { status });
test.each([
	["create-folder", "POST", create, "folder-create-ack"],
	["update-folder", "PATCH", update, "folder-update-ack"],
	["delete-folder", "DELETE", deletion, "folder-delete-ack"],
] as const)("%s sends exactly one canonical write", async (command, method, body, kind) => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe(
			command === "create-folder"
				? "/api/v1/folders"
				: "/api/v1/folders/folder",
		);
		expect(init.method).toBe(method);
		expect(init.redirect).toBe("error");
		expect(init.credentials).toBe("omit");
		expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
		expect(JSON.parse(String(init.body))).toEqual(body);
		return envelope(
			{
				kind,
				snapshot:
					command === "update-folder"
						? { ...snapshot, name: "Renamed" }
						: snapshot,
			},
			command === "create-folder" ? 201 : 200,
		);
	});
	await folderWorkflow(options(command), fetcher, async () =>
		encodeFolderWorkflowInput(command, body),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("observation encodes opaque ID without stdin or UUID", async () => {
	const reader = vi.fn();
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/folders/opaque%2Ffolder/observation");
		expect(new Headers(init.headers).has("idempotency-key")).toBe(false);
		return envelope({
			...observation,
			snapshot: { ...snapshot, id: "opaque/folder" },
		});
	});
	await folderWorkflow(
		{ ...options("observe-folder"), folderId: "opaque/folder" },
		fetcher,
		reader,
	);
	expect(reader).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	new Uint8Array([255]),
	new Uint8Array(4097),
	new TextEncoder().encode("{}{}"),
	new TextEncoder().encode(JSON.stringify({ ...create, extra: true })),
])("invalid stdin refuses before HTTP", async (bytes) => {
	const fetcher = vi.fn();
	await expect(
		folderWorkflow(options("create-folder"), fetcher, async () => bytes),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	".",
	"..",
	"\uD800",
	"bad\0",
])("invalid folder ID refuses before encoding %j", async (folderId) => {
	const fetcher = vi.fn();
	await expect(
		folderWorkflow({ ...options("observe-folder"), folderId }, fetcher),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
test("strict encoders refuse accessors, prototype keys and unsupported deletion without invoking getters", () => {
	const getter = vi.fn(() => "Projects");
	for (const value of [
		Object.defineProperty({ ...create }, "name", {
			enumerable: true,
			get: getter,
		}),
		Object.create(create),
		{ ...create, toJSON: getter },
		{ ...create, [Symbol("x")]: true },
	])
		expect(() => encodeFolderWorkflowInput("create-folder", value)).toThrow();
	expect(getter).not.toHaveBeenCalled();
	expect(() =>
		encodeFolderWorkflowInput("delete-folder", { ...deletion, cascade: true }),
	).toThrow();
});
test.each([
	401, 403, 404, 409, 429, 503,
])("HTTP%s preserves sanitized failure and never retries", async (status) => {
	const fetcher = vi.fn(async () => new Response(env.DITERO_TOKEN, { status }));
	const stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		["create-folder", "--request-id", key, "--json"],
		env,
		{ stdout, stderr },
		fetcher,
		async () => encodeFolderWorkflowInput("create-folder", create),
	);
	expect(exit).not.toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(stdout).not.toHaveBeenCalled();
	expect(stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
});
test("lost response permits only deliberate identical manual retry", async () => {
	const calls: RequestInit[] = [];
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		calls.push(init);
		if (calls.length === 1) throw new Error("lost");
		return envelope({ kind: "folder-create-ack", snapshot });
	});
	const attempt = () =>
		folderWorkflow(options("create-folder"), fetcher, async () =>
			encodeFolderWorkflowInput("create-folder", create),
		);
	await expect(attempt()).rejects.toMatchObject({ code: "network_error" });
	expect(calls).toHaveLength(1);
	await attempt();
	expect(calls[1].body).toBe(calls[0].body);
	expect(calls[1].headers).toEqual(calls[0].headers);
});
test.each([
	{
		kind: "folder-create-ack",
		snapshot: { ...snapshot, workspaceId: "other" },
	},
	{ kind: "folder-update-ack", snapshot },
	{ kind: "folder-create-ack", snapshot: { ...snapshot, extra: true } },
])("mismatched acknowledgment refuses %j", async (data) => {
	await expect(
		folderWorkflow(
			options("create-folder"),
			async () => envelope(data),
			async () => encodeFolderWorkflowInput("create-folder", create),
		),
	).rejects.toMatchObject({ code: "invalid_response" });
});
test("cancellation aborts HTTP once", async () => {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const abort = vi.fn();
	const controller = new AbortController();
	const fetcher = vi.fn(
		async (_url: URL, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				if (!init.signal) throw new Error("Missing cancellation signal");
				init.signal.addEventListener(
					"abort",
					() => {
						abort();
						reject(new Error("abort"));
					},
					{ once: true },
				);
				entered();
			}),
	);
	const pending = folderWorkflow(
		options("observe-folder"),
		fetcher,
		vi.fn(),
		controller.signal,
	);
	await started;
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	expect(abort).toHaveBeenCalledTimes(1);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each(
	[
		["observe-folder", "--folder", "folder", "--request-id", key],
		["create-folder", "--request-id", key, "--folder", "folder"],
		["delete-folder", "--folder", "folder", "--request-id", key, "--all"],
		["folders", "--folder", "folder"],
	].map((argv) => [argv] as const),
)("CLI refuses incompatible flags %j", (argv) => {
	expect(() => parseArguments(argv, env)).toThrow();
});

test("actual CLI stdin enforces4KiB before any request", async () => {
	const child = spawn(
		"bun",
		[
			"run",
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			"create-folder",
			"--request-id",
			key,
			"--json",
		],
		{ env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
	try {
		child.stdin.end(" ".repeat(4097));
		expect(await closed).toBe(2);
		expect(stdout).toBe("");
		expect(JSON.parse(stderr).error.code).toBe("invalid_input");
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await closed;
		}
	}
});
