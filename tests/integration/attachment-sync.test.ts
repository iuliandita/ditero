import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	aad,
	decryptWrapped,
	encryptWrapped,
} from "../../src/domain/e2e/envelope.ts";
import { decodeWrapped, encodeWrapped } from "../../src/domain/e2e/wire.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);
const WORKSPACE = "att-sync-w";
const attachmentIds = ["att-visible", "att-transition"] as const;
const userIds = ["att-owner", "att-member", "att-outsider"] as const;
const metadataKey = new Uint8Array(32).fill(7);
const filename = "private-medical-note.pdf";

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

async function encryptedField(
	attachmentId: string,
	field: "filename" | "contentType",
	value: string,
) {
	return encodeWrapped(
		await encryptWrapped(
			new TextEncoder().encode(value),
			metadataKey,
			aad.metadata(attachmentId, field),
		),
	);
}

async function encryptedDek(attachmentId: string) {
	return encodeWrapped(
		await encryptWrapped(
			new TextEncoder().encode("wrapped-dek"),
			metadataKey,
			aad.dek(WORKSPACE, 1, attachmentId),
		),
	);
}

async function wipe() {
	await db
		.delete(tables.attachment)
		.where(inArray(tables.attachment.id, [...attachmentIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WORKSPACE));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

beforeAll(async () => {
	await wipe();
	await db.insert(tables.user).values(
		userIds.map((id) => ({
			id,
			name: id,
			email: `${id}@test.invalid`,
		})),
	);
	await db.insert(tables.workspace).values({
		id: WORKSPACE,
		name: "Attachment sync",
		ownerId: "att-owner",
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{
			id: "att-sync-owner",
			userId: "att-owner",
			workspaceId: WORKSPACE,
			role: "owner",
		},
		{
			id: "att-sync-member",
			userId: "att-member",
			workspaceId: WORKSPACE,
			role: "member",
		},
	]);
	await db.insert(tables.attachment).values([
		{
			id: "att-visible",
			workspaceId: WORKSPACE,
			parentKind: "task",
			parentId: "parent-visible",
			keyVersion: 1,
			state: "committed",
			filenameCiphertext: await encryptedField(
				"att-visible",
				"filename",
				filename,
			),
			contentTypeCiphertext: await encryptedField(
				"att-visible",
				"contentType",
				"application/pdf",
			),
			dekWrapped: await encryptedDek("att-visible"),
			declaredBytes: 4096,
			observedBytes: 4096,
			ciphertextSha256: "a".repeat(64),
			storageKey: "attachments/att-visible",
			uploadedBy: "att-owner",
			committedAt: new Date("2026-09-02T00:00:00Z"),
		},
		{
			id: "att-transition",
			workspaceId: WORKSPACE,
			parentKind: "list",
			parentId: "parent-transition",
			keyVersion: 1,
			state: "reserved",
			filenameCiphertext: await encryptedField(
				"att-transition",
				"filename",
				"transition.txt",
			),
			contentTypeCiphertext: await encryptedField(
				"att-transition",
				"contentType",
				"text/plain",
			),
			dekWrapped: await encryptedDek("att-transition"),
			declaredBytes: 128,
			storageKey: "attachments/att-transition",
			uploadedBy: "att-owner",
			reservationExpiresAt: new Date("2026-09-02T01:00:00Z"),
		},
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

async function mine(userId: string) {
	const rows = await zdb.run(queries.attachments.mine.fn(ctx(userId)));
	return rows.filter((row) =>
		(attachmentIds as readonly string[]).includes(row.id),
	);
}

describe("attachments.mine", () => {
	test("a workspace member sees the committed row", async () => {
		expect((await mine("att-member")).map((row) => row.id)).toEqual([
			"att-visible",
		]);
	});

	test("a non-member sees no row while a member sees the same fixture", async () => {
		expect(await mine("att-outsider")).toEqual([]);
		expect((await mine("att-owner")).map((row) => row.id)).toContain(
			"att-visible",
		);
	});

	test("one row appears only while committed", async () => {
		expect((await mine("att-member")).map((row) => row.id)).not.toContain(
			"att-transition",
		);
		await db
			.update(tables.attachment)
			.set({
				state: "committed",
				observedBytes: 128,
				committedAt: new Date("2026-09-02T00:30:00Z"),
			})
			.where(
				and(
					eq(tables.attachment.id, "att-transition"),
					eq(tables.attachment.state, "reserved"),
				),
			);
		expect((await mine("att-member")).map((row) => row.id)).toContain(
			"att-transition",
		);

		await db
			.update(tables.attachment)
			.set({
				state: "deleting",
				deletedAt: new Date("2026-09-02T00:45:00Z"),
			})
			.where(eq(tables.attachment.id, "att-transition"));
		expect((await mine("att-member")).map((row) => row.id)).not.toContain(
			"att-transition",
		);
	});

	test("the synced filename is an envelope, never plaintext", async () => {
		const row = (await mine("att-member")).find(
			(candidate) => candidate.id === "att-visible",
		);
		if (!row) throw new Error("committed attachment did not sync");
		expect(row.filenameCiphertext).not.toBe(filename);
		const wrapped = decodeWrapped(row.filenameCiphertext);
		expect(
			new TextDecoder().decode(
				await decryptWrapped(
					wrapped,
					metadataKey,
					aad.metadata("att-visible", "filename"),
				),
			),
		).toBe(filename);
		expect(schema.tables.attachment.columns).not.toHaveProperty("filename");
	});
});
