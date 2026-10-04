import { describe, expect, it, vi } from "vitest";
import release from "../../release.json";
import { CliError, canonicalServer, parseArguments } from "./arguments.ts";
import { discover, MAX_PAGES, MAX_RESPONSE_BYTES } from "./client.ts";
import { runCli } from "./index.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const workspace = {
	id: "workspace",
	name: "Home",
	kind: "shared",
	ownerId: "owner",
	role: "member",
};
const page = (data: unknown, nextCursor: string | null = null) =>
	Response.json({ version: 1, data, nextCursor });
const options = (args: string[]) => {
	const parsed = parseArguments(args, env);
	if (!parsed) throw new Error("Expected command options");
	return parsed;
};

describe("CLI arguments and credentials", () => {
	it("supports environment defaults and task filters", () => {
		expect(
			options([
				"tasks",
				"--json",
				"--limit",
				"100",
				"--workspace",
				"home",
				"--list",
				"chores",
				"--done",
				"false",
			]),
		).toMatchObject({
			command: "tasks",
			json: true,
			limit: 100,
			workspaceId: "home",
			listId: "chores",
			done: "false",
		});
	});
	it.each([
		"http://todo.example.test",
		"https://user:secret@todo.example.test",
		"https://todo.example.test/path",
		"https://todo.example.test?secret=x",
		"https://todo.example.test#secret",
		"http://127.1",
		"http://2130706433",
		"http://localhost.example.test",
		" https://todo.example.test",
		"https://todo.example.test\\@evil.test",
	])("rejects unsafe origins %s", (server) => {
		expect(() => canonicalServer(server, true)).toThrow(CliError);
	});
	it.each([
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"http://[::1]:3000",
	])("requires explicit development permission for %s", (server) => {
		expect(() => canonicalServer(server, false)).toThrow(CliError);
		expect(canonicalServer(server, true)).toBe(server);
	});
	it.each([
		["tasks", "--token", "secret"],
		["tasks", "--limit", "101"],
		["tasks", "--limit", "0"],
		["tasks", "--limit", "01"],
		["tasks", "--limit", "1", "--limit", "2"],
		["tasks", "--cursor", "a/b"],
		["tasks", "--done", "yes"],
		["lists", "--done", "true"],
		["profile", "--all"],
		["profile", "--workspace", "home"],
		["tasks", "--workspace", "x".repeat(257)],
	])("rejects invalid command %j", (...argv: string[]) => {
		expect(() => options(argv)).toThrow(CliError);
	});
	it("provides help without credentials or a request", async () => {
		const stdout = vi.fn();
		const fetcher = vi.fn();
		expect(
			await runCli(["--help"], {}, { stdout, stderr: vi.fn() }, fetcher),
		).toBe(0);
		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("DITERO_TOKEN"),
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("CLI reads", () => {
	it("rejects prototype keys that schema strict mode can otherwise discard", async () => {
		const raw =
			'{"version":1,"data":[],"nextCursor":null,"__proto__":{"token":"private"}}';
		await expect(
			discover(
				options(["workspaces"]),
				async () =>
					new Response(raw, {
						headers: { "content-type": "application/json" },
					}),
			),
		).rejects.toMatchObject({ code: "invalid_response" });
	});
	it("uses fixed authenticated GET routes and preserves opaque pagination filters", async () => {
		const urls: URL[] = [];
		const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
			urls.push(url);
			expect(init).toMatchObject({
				method: "GET",
				redirect: "error",
				credentials: "omit",
				headers: {
					authorization: `Bearer ${env.DITERO_TOKEN}`,
					accept: "application/json",
				},
			});
			return urls.length === 1
				? page([workspace], "cursor_2")
				: page([{ ...workspace, id: "second" }]);
		});
		expect(
			await discover(
				options(["workspaces", "--all", "--limit", "1", "--workspace", "home"]),
				fetcher,
			),
		).toEqual({
			version: 1,
			data: [workspace, { ...workspace, id: "second" }],
			nextCursor: null,
		});
		expect(urls.map((url) => url.pathname)).toEqual([
			"/api/v1/workspaces",
			"/api/v1/workspaces",
		]);
		expect(urls[1].searchParams.get("cursor")).toBe("cursor_2");
		expect(urls[1].searchParams.get("workspaceId")).toBe("home");
		expect(urls[1].searchParams.get("limit")).toBe("1");
	});
	it("returns a single page cursor and validates profile contract", async () => {
		expect(
			(
				await discover(options(["workspaces"]), async () =>
					page([workspace], "next"),
				)
			).nextCursor,
		).toBe("next");
		const profile = {
			id: "user",
			name: "Alex",
			timezone: "UTC",
			timezoneChosen: true,
			locale: "en",
			serverTime: "2026-10-03T12:00:00Z",
			tokenAccess: "read",
		};
		const fetcher = vi.fn(async (url: URL) => {
			expect(url.href).toBe("https://todo.example.test/api/v1/me");
			return page(profile);
		});
		expect((await discover(options(["profile"]), fetcher)).data).toEqual(
			profile,
		);
	});
	it.each([
		page([{ ...workspace, token: "private" }]),
		page([{ ...workspace, role: "unknown" }]),
		Response.json({ version: 2, data: [], nextCursor: null }),
		Response.json({ version: 1, data: [], nextCursor: null, extra: "secret" }),
		page([], "bad/cursor"),
		page([workspace, workspace]),
	])("rejects invalid DTOs and envelopes", async (response) => {
		await expect(
			discover(options(["workspaces", "--limit", "1"]), async () => response),
		).rejects.toMatchObject({ code: "invalid_response", exitCode: 8 });
	});
	it("rejects repeated cursors before publishing partial output", async () => {
		const stdout = vi.fn();
		const stderr = vi.fn();
		const fetcher = vi.fn(async () => page([workspace], "cycle"));
		expect(
			await runCli(
				["workspaces", "--all", "--json"],
				env,
				{ stdout, stderr },
				fetcher,
			),
		).toBe(8);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(stdout).not.toHaveBeenCalled();
	});
	it("bounds the number of pages", async () => {
		let count = 0;
		await expect(
			discover(options(["workspaces", "--all"]), async () =>
				page([], `cursor_${++count}`),
			),
		).rejects.toMatchObject({ code: "pagination_limit" });
		expect(count).toBe(MAX_PAGES);
	});
	it("bounds observed streamed bytes and cancels excess response content", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel,
		});
		await expect(
			discover(
				options(["workspaces"]),
				async () =>
					new Response(stream, {
						headers: { "content-type": "application/json" },
					}),
			),
		).rejects.toMatchObject({ code: "invalid_response" });
		expect(cancel).toHaveBeenCalled();
	});
	it.each([
		[401, 3],
		[403, 4],
		[404, 5],
		[429, 6],
		[500, 9],
	])("reports status %s without reflecting private error content", async (status, exit) => {
		const stderr = vi.fn();
		expect(
			await runCli(
				["workspaces", "--json"],
				env,
				{ stdout: vi.fn(), stderr },
				async () => new Response(env.DITERO_TOKEN, { status }),
			),
		).toBe(exit);
		const printed = stderr.mock.calls[0][0];
		expect(printed).not.toContain(env.DITERO_TOKEN);
		expect(JSON.parse(printed).error.status).toBe(status);
	});
	it("redacts transport errors and private arguments", async () => {
		const stderr = vi.fn();
		expect(
			await runCli(
				["workspaces", "--json"],
				env,
				{ stdout: vi.fn(), stderr },
				async () => {
					throw new Error(env.DITERO_TOKEN);
				},
			),
		).toBe(7);
		expect(stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
		stderr.mockClear();
		expect(
			await runCli(["workspaces", "--json", "--token", env.DITERO_TOKEN], env, {
				stdout: vi.fn(),
				stderr,
			}),
		).toBe(2);
		expect(stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
	});
});

it("prints release identity without credentials or a network request", async () => {
	const stdout = vi.fn();
	const stderr = vi.fn();
	const fetcher = vi.fn();
	expect(await runCli(["--version"], {}, { stdout, stderr }, fetcher)).toBe(0);
	expect(stdout).toHaveBeenCalledWith(
		`ditero ${release.version} (development+modified; source)\n`,
	);
	expect(stderr).not.toHaveBeenCalled();
	expect(fetcher).not.toHaveBeenCalled();
	expect(
		await runCli(["profile", "--version"], env, { stdout, stderr }, fetcher),
	).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});

it("list workflow flags require explicit list/UUID and reject discovery/authority options", () => {
	const key = "00000000-0000-4000-8000-000000000001";
	expect(options(["create-list", "--request-id", key]).command).toBe(
		"create-list",
	);
	expect(options(["observe-list", "--list", "list"]).listId).toBe("list");
	expect(
		options(["update-list", "--list", "list", "--request-id", key]).requestId,
	).toBe(key);
	for (const argv of [
		["create-list"],
		["create-list", "--list", "list", "--request-id", key],
		["observe-list"],
		["observe-list", "--list", "list", "--request-id", key],
		["update-list", "--request-id", key],
		["update-list", "--list", "list", "--request-id", key, "--all"],
		["observe-list", "--list", "list", "--workspace", "workspace"],
	])
		expect(() => options(argv)).toThrow(CliError);
});

it("reads strict folder pages through shared discovery", async () => {
	const seen: string[] = [];
	const folder = {
		id: "folder",
		workspaceId: "workspace",
		name: "Projects",
		sortKey: "a0",
	};
	const result = await discover(
		options(["folders", "--workspace", "workspace"]),
		async (url) => {
			seen.push(String(url));
			return page([folder]);
		},
	);
	expect(result.data).toEqual([folder]);
	expect(seen[0]).toContain("/api/v1/folders");
	expect(seen[0]).toContain("workspaceId=workspace");
});
