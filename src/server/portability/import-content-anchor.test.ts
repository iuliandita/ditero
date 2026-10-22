import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import { parseContentProvider } from "../../domain/portability/providers/content.ts";
import type { ContentOptions } from "../../domain/portability/providers/content-common.ts";
import {
	type ContentInputBinding,
	contentBinding,
} from "../../domain/portability/providers/content-input.ts";
import { prepareAnchoredProviderImport } from "./import-content-anchor.ts";

const options: ContentOptions = {
	exportedAt: "2026-12-31T12:00:00.000Z",
	projectFolderName: "Project",
	unsectionedListName: "Unsectioned",
	timezone: "UTC",
};
const nextDay = "2027-01-02T12:00:00.000Z";
const bytes = (date: string) =>
	new TextEncoder().encode(
		`TYPE,CONTENT,DATE,DATE_LANG\ntask,Task,${date},en\n`,
	);

test("Todoist binds no anchor for undated, absolute, fixed-start or unsupported dates across days", async () => {
	for (const date of [
		"",
		"2026-10-21",
		"every week starting 2026-10-21",
		"tomorrow",
	]) {
		const first = await parseContentProvider("todoist", bytes(date), options);
		const later = await parseContentProvider("todoist", bytes(date), {
			...options,
			exportedAt: nextDay,
			anchorDay: "2027-01-02",
		});
		expect(first.anchorDay, date).toBeNull();
		expect(later.anchorDay, date).toBeNull();
		expect(contentBinding(later), date).toEqual(contentBinding(first));
		expect(later.document.data.tasks, date).toEqual(first.document.data.tasks);
	}
});

function sourcePool(binding: ContentInputBinding) {
	const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
		if (sql.includes('from "user"'))
			return { rowCount: 1, rows: [{ id: "owner" }] };
		if (sql.includes("from import_source")) {
			expect(sql).toContain("id = $1 and owner_user_id = $2");
			expect(parameters).toEqual(["source", "owner"]);
			return { rowCount: 1, rows: [{ input_binding: binding }] };
		}
		return { rowCount: 0, rows: [] };
	});
	const client = { query, release: vi.fn() } as unknown as PoolClient;
	return {
		pool: { connect: vi.fn(async () => client) } as unknown as Pool,
		query,
	};
}

async function upload(
	date: string,
	exportedAt: string,
	changes: Partial<ContentOptions> = {},
) {
	const original = bytes(date);
	const conversion = await parseContentProvider("todoist", original, {
		...options,
		exportedAt,
		...changes,
	});
	return {
		conversion,
		input: {
			...contentBinding(conversion),
			originalBase64: Buffer.from(original).toString("base64"),
		},
	};
}

test("server replan keeps original recurrence and implicit-year anchors after reparsing identical bytes", async () => {
	for (const date of [
		"every day",
		"every Friday",
		"Oct 21",
		"every week starting Oct 21",
	]) {
		const first = await upload(date, options.exportedAt);
		const later = await upload(date, nextDay);
		expect(first.input.anchorDay, date).toBe("2026-12-31");
		expect(later.input.anchorDay, date).toBe("2027-01-02");
		expect(later.conversion.document.data.tasks, date).not.toEqual(
			first.conversion.document.data.tasks,
		);
		const { pool } = sourcePool(contentBinding(first.conversion));
		const prepared = await prepareAnchoredProviderImport(
			pool,
			"owner",
			{ mode: "existing", id: "source" },
			later.input,
			{ exportedAt: nextDay },
		);
		expect(prepared.binding, date).toEqual(contentBinding(first.conversion));
		expect(prepared.conversion.document.data.tasks, date).toEqual(
			first.conversion.document.data.tasks,
		);
		// Fresh sources keep their own anchor and must not read another source.
		const freshPool = { connect: vi.fn() };
		const fresh = await prepareAnchoredProviderImport(
			freshPool as unknown as Pool,
			"owner",
			{ mode: "new", id: "new", label: "New" },
			later.input,
			{ exportedAt: nextDay },
		);
		expect(fresh.binding).toEqual(contentBinding(later.conversion));
		expect(freshPool.connect).not.toHaveBeenCalled();
		// Rebinding must not erase an independently validated timezone or snapshot change.
		for (const changed of [
			await upload(date, nextDay, { timezone: "Europe/Berlin" }),
			await upload(`${date} `, nextDay),
		]) {
			const result = await prepareAnchoredProviderImport(
				pool,
				"owner",
				{ mode: "existing", id: "source" },
				changed.input,
				{ exportedAt: nextDay },
			);
			expect(result.binding).toEqual(contentBinding(changed.conversion));
			expect(result.binding).not.toEqual(prepared.binding);
		}
		const before = vi.mocked(pool.connect).mock.calls.length;
		await expect(
			prepareAnchoredProviderImport(
				pool,
				"owner",
				{ mode: "existing", id: "source" },
				{ ...later.input, snapshotSha256: "0".repeat(64) },
				{ exportedAt: nextDay },
			),
		).rejects.toBeInstanceOf(Error);
		expect(pool.connect).toHaveBeenCalledTimes(before);
	}
});

test("server replan retains a leap-year anchor when the current year cannot parse Feb 29", async () => {
	const first = await upload("Feb 29", "2028-01-15T12:00:00.000Z");
	const later = await upload("Feb 29", "2029-01-15T12:00:00.000Z");
	expect(first.input.anchorDay).toBe("2028-01-15");
	expect(later.input.anchorDay).toBeNull();
	expect(later.conversion.document.data.tasks[0]?.dueAt).toBeNull();
	const { pool } = sourcePool(contentBinding(first.conversion));
	const prepared = await prepareAnchoredProviderImport(
		pool,
		"owner",
		{ mode: "existing", id: "source" },
		later.input,
		{ exportedAt: "2029-01-15T12:00:00.000Z" },
	);
	expect(prepared.binding).toEqual(contentBinding(first.conversion));
	expect(prepared.conversion.document.data.tasks[0]?.dueAt).toBe(
		"2028-02-29T00:00:00.000Z",
	);
});
