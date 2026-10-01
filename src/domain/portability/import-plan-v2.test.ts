import { describe, expect, test, vi } from "vitest";
import {
	buildHistoricalImportPlan,
	type HistoricalTargetParents,
} from "./import-plan-v2.ts";
import type { PortableExportV2 } from "./v2.ts";
import { parsePortableExportV2 } from "./validate-v2.ts";

const stamp = "2026-01-01T00:00:00.000Z";
const namespace = "8F63B9C0-6AC5-4A79-98C2-F0582D21056E";
const targetTask = "DBBF4D7C-760E-42BD-87B8-E6157775A57A";
const targetWorkspace = "77757364-E411-4AD1-B61E-02167F21BED2";

function archive(): PortableExportV2 {
	return {
		format: "ditero",
		schemaVersion: 2,
		exportedAt: stamp,
		sourceUserId: "person",
		sourceNamespace: namespace,
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "recorded-events-only",
		},
		data: {
			principals: [{ id: "person", name: "Writer" }],
			workspaces: [
				{ id: "workspace", name: "Shared", ownerId: "person", kind: "shared" },
			],
			memberships: [
				{
					id: "seat",
					userId: "person",
					workspaceId: "workspace",
					role: "owner",
				},
			],
			folders: [],
			lists: [
				{
					id: "list",
					workspaceId: "workspace",
					ownerId: "person",
					title: "List",
					kind: "tasks",
					icon: null,
					folderId: null,
					sortKey: "a",
					completedDisplay: "sink",
				},
			],
			tasks: [
				{
					id: "task",
					listId: "list",
					title: "Task",
					done: false,
					notes: null,
					dueAt: null,
					dueAllDay: false,
					priority: 0,
					completedAt: null,
					sortKey: "a",
					parentId: null,
					quantity: null,
					unit: null,
					category: null,
					rrule: null,
					recurrenceRelative: false,
					reminderTime: null,
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				},
			],
			labels: [],
			taskLabels: [],
			templates: [
				{
					id: "archive-template-row",
					sourceRef: { namespace, collection: "templates", id: "template" },
					workspaceId: "workspace",
					kind: "task",
					name: "Template",
					icon: null,
					content: { kind: "task", task: { title: "Template task" } },
					creator: { kind: "native_user", principalId: "person" },
				},
			],
			assignments: [],
			comments: [
				{
					id: "archive-comment-row",
					sourceRef: { namespace, collection: "comments", id: "" },
					taskId: "task",
					body: "Hello",
					createdAt: stamp,
					editedAt: null,
					author: { kind: "native_user", principalId: "person" },
				},
			],
			habitLogs: [],
			focusSessions: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
			completionEvents: [
				{
					id: "archive-event-row",
					sourceRef: { namespace, collection: "completionEvents", id: "event" },
					taskId: "task",
					occurredAt: stamp,
					actor: { kind: "native_user", principalId: "person" },
					origin: { kind: "native", mechanism: "member_mutation" },
					action: "complete",
					beforeDueAt: null,
					beforeDueAllDay: false,
					beforeDone: false,
					afterDueAt: null,
					afterDone: true,
				},
			],
		},
	};
}

const parents = (): HistoricalTargetParents => ({
	tasks: new Map([["task", targetTask]]),
	workspaces: new Map([["workspace", targetWorkspace]]),
});
const plan = (document: PortableExportV2, resolved = parents()) =>
	buildHistoricalImportPlan(
		parsePortableExportV2(JSON.stringify(document)),
		resolved,
	);

describe("v5 historical planning", () => {
	test("pins each v5 semantic digest domain", async () => {
		const result = await plan(archive());
		expect(
			Object.fromEntries(
				result.map((item) => [item.collection, item.semanticDigest]),
			),
		).toEqual({
			comments:
				"50a38860afbb76fb70536742148283759b78cf3ad1d34f9e6001cbf7cc7d4fe3",
			templates:
				"cbfc655e624f5e78050bda2e304d3e208502e5368722b33b331e049ae05d7b8b",
			completionEvents:
				"9ad7c02b8b5acd297c06891c628d3f587eb10fddaeb8edf0d7e20545847cbf6e",
		});
	});
	test.each([
		"cancel",
		"reject",
	] as const)("settles outstanding digest work before %s rejection", async (mode) => {
		const controller = new AbortController();
		const hashes: {
			resolve: (value: ArrayBuffer) => void;
			reject: (reason: Error) => void;
		}[] = [];
		const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(
			() =>
				new Promise<ArrayBuffer>((resolve, reject) => {
					hashes.push({ resolve, reject });
				}),
		);
		try {
			const pending = buildHistoricalImportPlan(archive(), parents(), {
				signal: controller.signal,
			});
			let finished = false;
			const observed = pending.then(
				() => {
					finished = true;
				},
				() => {
					finished = true;
				},
			);
			expect(hashes).toHaveLength(6);
			if (mode === "cancel") {
				controller.abort();
				hashes[0].resolve(new ArrayBuffer(32));
			} else hashes[0].reject(new Error("digest failure"));
			await Promise.resolve();
			await Promise.resolve();
			expect(finished).toBe(false);
			for (const hash of hashes.slice(1)) hash.resolve(new ArrayBuffer(32));
			if (mode === "cancel")
				await expect(pending).rejects.toMatchObject({
					code: "planning-cancelled",
				});
			else await expect(pending).rejects.toThrow("digest failure");
			await observed;
			expect(finished).toBe(true);
		} finally {
			digest.mockRestore();
		}
	});

	test("normalizes native and equivalent claimed provenance, including origin", async () => {
		const native = archive();
		const original = await plan(native);
		const claimed = archive();
		const author = {
			kind: "source_claim" as const,
			sourceNamespace: namespace.toLowerCase(),
			sourcePrincipalId: "person",
			displayName: "Writer",
		};
		claimed.data.comments[0].author = author;
		claimed.data.templates[0].creator = author;
		claimed.data.completionEvents[0].actor = author;
		claimed.data.completionEvents[0].origin = {
			kind: "source_claim",
			mechanism: "member_mutation",
			label: null,
		};
		const equivalent = await plan(claimed);
		expect(equivalent.map((item) => item.semanticDigest)).toEqual(
			original.map((item) => item.semanticDigest),
		);
		expect(original[0].ledger.sourceId).toBe("");
		expect(original[0].ledger.sourceNamespace).toBe(namespace.toLowerCase());
		expect(original[0].ledger.targetParentId).toBe(targetTask);
		expect(original[0].ledger.sourceIdHash).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	test("remaps archive parents across a multi-hop archive while retaining claimed provenance", async () => {
		const first = await plan(archive());
		const next = archive();
		next.exportedAt = "2026-02-01T00:00:00.000Z";
		next.data.comments[0].id = "new-local-comment-row";
		next.data.templates[0].id = "new-local-template-row";
		next.data.completionEvents[0].id = "new-local-event-row";
		const author = {
			kind: "source_claim" as const,
			sourceNamespace: namespace.toLowerCase(),
			sourcePrincipalId: "person",
			displayName: "Writer",
		};
		next.sourceUserId = "next-person";
		next.sourceNamespace = "0fd6cf11-b9b7-4cc9-aa9f-478c7058d169";
		next.data.principals[0].id = "next-person";
		next.data.workspaces[0].id = "next-workspace";
		next.data.workspaces[0].ownerId = "next-person";
		next.data.memberships[0].userId = "next-person";
		next.data.memberships[0].workspaceId = "next-workspace";
		next.data.lists[0].id = "next-list";
		next.data.lists[0].workspaceId = "next-workspace";
		next.data.lists[0].ownerId = "next-person";
		next.data.tasks[0].id = "next-task";
		next.data.tasks[0].listId = "next-list";
		next.data.comments[0].taskId = "next-task";
		next.data.comments[0].author = author;
		next.data.templates[0].workspaceId = "next-workspace";
		next.data.templates[0].creator = author;
		next.data.completionEvents[0].taskId = "next-task";
		next.data.completionEvents[0].actor = author;
		next.data.completionEvents[0].origin = {
			kind: "source_claim",
			mechanism: "member_mutation",
			label: null,
		};
		const second = await plan(next, {
			tasks: new Map([["next-task", targetTask]]),
			workspaces: new Map([["next-workspace", targetWorkspace]]),
		});
		expect(second.map((item) => item.archiveParentId)).toEqual([
			"next-task",
			"next-task",
			"next-workspace",
		]);
		expect(second.map((item) => item.semanticDigest)).toEqual(
			first.map((item) => item.semanticDigest),
		);
		expect(second.map((item) => item.ledger)).toEqual(
			first.map((item) => item.ledger),
		);
	});

	test("preserves source claims and unknown authors without local mapping", async () => {
		const source = archive();
		source.data.comments[0].author = { kind: "unknown" };
		source.data.templates[0].creator = {
			kind: "source_claim",
			sourceNamespace: namespace,
			sourcePrincipalId: "former-person",
			displayName: null,
		};
		source.data.completionEvents[0].origin = { kind: "unknown" };
		const result = await plan(source);
		expect(
			result.find((item) => item.collection === "comments")?.semanticPayload,
		).toMatchObject({
			author: { kind: "unknown" },
		});
		expect(
			result.find((item) => item.collection === "templates")?.semanticPayload,
		).toMatchObject({
			creator: { sourcePrincipalId: "former-person", displayName: null },
		});
		expect(
			result.find((item) => item.collection === "completionEvents")
				?.semanticPayload,
		).toMatchObject({
			origin: { kind: "unknown" },
		});
	});

	test("rejects a native display name longer than 512 UTF-16 units", async () => {
		const source = archive();
		source.data.principals[0].name = "x".repeat(513);
		await expect(plan(source)).rejects.toMatchObject({
			code: "historical-author-name-too-long",
		});
	});

	test("binds content and resolved parents, including independent copies", async () => {
		const source = archive();
		const first = await plan(source);
		source.data.comments[0].body = "Changed";
		const changed = await plan(source);
		expect(changed[0].semanticDigest).not.toBe(first[0].semanticDigest);
		const copyParents = parents();
		copyParents.tasks = new Map([["task", "another-parent"]]);
		const copy = await plan(archive(), copyParents);
		expect(copy[0].ledger.targetParentId).toBe("another-parent");
		expect(copy[0].semanticDigest).not.toBe(first[0].semanticDigest);
		await expect(
			plan(archive(), { ...parents(), tasks: new Map() }),
		).rejects.toMatchObject({
			code: "invalid-mappings",
		});
	});

	test("preserves case-sensitive target parents as distinct copies", async () => {
		const original = archive();
		const uppercase = await plan(original, {
			...parents(),
			tasks: new Map([["task", "MixedCaseParent"]]),
		});
		const lowercase = await plan(original, {
			...parents(),
			tasks: new Map([["task", "mixedcaseparent"]]),
		});
		expect(uppercase[0].ledger.targetParentId).toBe("MixedCaseParent");
		expect(lowercase[0].ledger.targetParentId).toBe("mixedcaseparent");
		expect(uppercase[0].ledger).not.toEqual(lowercase[0].ledger);
		expect(uppercase[0].semanticDigest).not.toBe(lowercase[0].semanticDigest);
	});

	test("keeps exact source IDs distinct even when serialization could be ambiguous", async () => {
		const source = archive();
		source.data.comments.push({
			...source.data.comments[0],
			id: "another-row",
			sourceRef: { namespace, collection: "comments", id: 'x"],y' },
		});
		source.data.comments[0].sourceRef.id = "x";
		const result = await plan(source);
		expect(result[0].ledger.sourceIdHash).not.toBe(
			result[1].ledger.sourceIdHash,
		);
		expect(result[0].ledger.sourceId).toBe("x");
		expect(result[1].ledger.sourceId).toBe('x"],y');
		source.data.comments.reverse();
		const reordered = await plan(source);
		expect(reordered.map((item) => item.ledger)).toEqual(
			result.map((item) => item.ledger),
		);
	});

	test("honors cancellation and deadlines", async () => {
		await expect(
			buildHistoricalImportPlan(archive(), parents(), {
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ code: "planning-cancelled" });
		await expect(
			buildHistoricalImportPlan(archive(), parents(), {
				deadline: performance.now() - 1,
			}),
		).rejects.toMatchObject({ code: "planning-timeout" });
		const controller = new AbortController();
		const pending = buildHistoricalImportPlan(archive(), parents(), {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "planning-cancelled" });
	});

	test("checks its deadline during graph indexing", async () => {
		const source = archive();
		source.data.principals.push(
			...Array.from({ length: 100 }, (_, i) => ({
				id: `other-${i}`,
				name: "Other",
			})),
		);
		let clockReads = 0;
		const now = vi
			.spyOn(performance, "now")
			.mockImplementation(() => ++clockReads);
		try {
			await expect(
				buildHistoricalImportPlan(source, parents(), { deadline: 30 }),
			).rejects.toMatchObject({ code: "planning-timeout" });
			expect(clockReads).toBe(30);
		} finally {
			now.mockRestore();
		}
	});
});
