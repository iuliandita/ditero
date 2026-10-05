import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterEach, expect, test, vi } from "vitest";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import {
	snapshotNamespace,
	TRELLO_V1_EXCLUSIONS,
} from "../../domain/portability/providers/common.ts";
import * as providerInput from "../../domain/portability/providers/input.ts";
import { prepareProviderImportRequest } from "../../domain/portability/providers/input.ts";
import { listImportSources, saveImportPlan } from "./import-plan-store.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const exportedAt = "2026-01-15T12:00:00.000Z";
const SOURCE = "8f5d4f0e-2f4b-4c1a-9a53-0f6a5f4a7c11";

async function trelloPlan() {
	const bytes = readFileSync(
		new URL(
			"../../../tests/fixtures/portability/providers/trello-board-v1.json",
			import.meta.url,
		),
	);
	const boardIdSha256 = createHash("sha256")
		.update("ditero-trello-board-v1\n64a1b2c3d4e5f60718293a4b")
		.digest("hex");
	const prepared = await prepareProviderImportRequest(
		{
			kind: "provider",
			version: 1,
			adapter: "trello-board-json",
			adapterVersion: 1,
			sourceNamespace: snapshotNamespace(boardIdSha256),
			identityMode: "stable-ids",
			boardIdSha256,
			snapshotSha256: createHash("sha256").update(bytes).digest("hex"),
			exclusions: [...TRELLO_V1_EXCLUSIONS],
			originalJsonBase64: bytes.toString("base64"),
		},
		{ exportedAt },
	);
	const { document } = prepared.conversion;
	return {
		prepared,
		document,
		mappings: {
			workspaces: {
				[document.data.workspaces[0]?.id ?? ""]: "target-workspace",
			},
			principals: { [document.sourceUserId]: "caller" },
		},
	};
}
function reachablePool() {
	const connect = vi.fn().mockRejectedValue(new Error("reached the pool"));
	return { pool: { connect } as unknown as Pool, connect };
}

test("checks the Trello board identity and conversion before reaching the database", async () => {
	const { prepared, document, mappings } = await trelloPlan();
	const { pool, connect } = reachablePool();
	await expect(
		saveImportPlan(
			pool,
			"caller",
			{ mode: "new", id: SOURCE, label: "Board" },
			document,
			mappings,
			{ plannerVersion: 4, inputBinding: prepared.binding },
		),
	).rejects.toThrow("reached the pool");
	expect(connect).toHaveBeenCalledTimes(1);
});

test.each([
	["a different board identity", { boardIdSha256: "b".repeat(64) }],
	["a CSV claim over Trello content", { adapter: "ditero-csv" }],
])("refuses a forged Trello binding with %s before touching the database", async (_name, change) => {
	const { prepared, document, mappings } = await trelloPlan();
	const { pool, connect } = reachablePool();
	const forged = { ...prepared.binding, ...change } as typeof prepared.binding;
	await expect(
		saveImportPlan(
			pool,
			"caller",
			{ mode: "new", id: SOURCE, label: "Board" },
			document,
			mappings,
			{ plannerVersion: 4, inputBinding: forged },
		),
	).rejects.toBeInstanceOf(Error);
	expect(connect).not.toHaveBeenCalled();
});

test("commits the supplied snapshot binding without claiming raw-byte verification from converted content", async () => {
	const { prepared, document, mappings } = await trelloPlan();
	const binding = { ...prepared.binding, snapshotSha256: "c".repeat(64) };
	const digest = vi.spyOn(providerInput, "providerDocumentDigest");
	const { pool, connect } = reachablePool();
	await expect(
		saveImportPlan(
			pool,
			"caller",
			{ mode: "new", id: SOURCE, label: "Board" },
			document,
			mappings,
			{
				plannerVersion: 4,
				inputBinding: binding,
			},
		),
	).rejects.toThrow("reached the pool");
	expect(connect).toHaveBeenCalledTimes(1);
	expect(digest).toHaveBeenCalledTimes(1);
	const [committedBinding, ordinaryDocumentDigest] = digest.mock.calls[0] ?? [];
	expect(committedBinding).toEqual(binding);
	expect(ordinaryDocumentDigest).toMatch(/^[0-9a-f]{64}$/);
	expect(await digest.mock.results[0]?.value).toBe(
		await hashImportValue(
			"ditero-import-provider-document-v1",
			{ binding, ordinaryDocumentDigest },
			() => {},
		),
	);
});

test("refuses a Trello binding on another namespace or an unsupported planner", async () => {
	const { prepared, document, mappings } = await trelloPlan();
	const { pool, connect } = reachablePool();
	const source = { mode: "new", id: SOURCE, label: "Board" } as const;
	await expect(
		saveImportPlan(
			pool,
			"caller",
			source,
			{
				...document,
				sourceUserId: "migration:trello-board-json:1:other:owner",
			},
			mappings,
			{ plannerVersion: 4, inputBinding: prepared.binding },
		),
	).rejects.toBeInstanceOf(Error);
	await expect(
		saveImportPlan(pool, "caller", source, document, mappings, {
			plannerVersion: 3,
			inputBinding: prepared.binding,
		}),
	).rejects.toMatchObject({ code: "invalid-provider-plan", status: 400 });
	expect(connect).not.toHaveBeenCalled();
});

test("timed-out acquisitions bound abandoned waiters and release late clients", async () => {
	const arrivals: ((client: PoolClient) => void)[] = [];
	const connect = vi.fn(
		() => new Promise<PoolClient>((resolve) => arrivals.push(resolve)),
	);
	const pool = { connect } as unknown as Pool;
	// list/status operations have no request signal; exercise save's shared acquisition
	// through a query deadline here. Abandoned waiters must still remain bounded.
	vi.useFakeTimers();
	for (let index = 0; index < 2; index++) {
		const pending = listImportSources(pool, "caller");
		const rejected = expect(pending).rejects.toMatchObject({
			code: "import-timeout",
			status: 503,
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
	}
	await expect(listImportSources(pool, "caller")).rejects.toMatchObject({
		code: "import-busy",
		status: 429,
	});
	expect(connect).toHaveBeenCalledTimes(2);
	for (const arrive of arrivals) {
		const release = vi.fn();
		arrive({ release } as unknown as PoolClient);
		await Promise.resolve();
		expect(release).toHaveBeenCalledTimes(1);
	}
	connect.mockRejectedValueOnce(new Error("pool recovered"));
	await expect(listImportSources(pool, "caller")).rejects.toThrow(
		"pool recovered",
	);
});

test("a stalled BEGIN loses its connection at the transaction deadline", async () => {
	vi.useFakeTimers();
	let rejectQuery: ((reason: Error) => void) | undefined;
	const query = vi.fn(
		() =>
			new Promise((_, reject) => {
				rejectQuery = reject;
			}),
	);
	const release = vi.fn(() =>
		rejectQuery?.(new Error("Connection terminated")),
	);
	const client = { query, release } as unknown as PoolClient;
	const pool = {
		connect: vi.fn().mockResolvedValue(client),
	} as unknown as Pool;
	const pending = listImportSources(pool, "caller");
	const rejected = expect(pending).rejects.toMatchObject({
		code: "import-timeout",
		status: 503,
	});
	await vi.advanceTimersByTimeAsync(15_000);
	await rejected;
	expect(query).toHaveBeenCalledWith("begin");
	expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
