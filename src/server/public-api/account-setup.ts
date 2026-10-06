import type { PoolClient } from "pg";
import {
	accountSetupStatusResponseSchema,
	deriveAccountSetupStatus,
} from "../../domain/account-setup-status.ts";
import { accountSetupStoredStateSchema } from "../../domain/account-setup-storage.ts";
import {
	apiResult,
	PUBLIC_API_ID,
	PUBLIC_API_VERSION,
	PublicApiError,
} from "../../domain/public-api.ts";
import type { ApiActor } from "./tokens.ts";

function invalid(): never {
	throw new PublicApiError(
		500,
		"invalid-setup-state",
		"Stored account setup state is invalid",
	);
}
function revision(value: unknown): number {
	if (
		typeof value !== "number" &&
		typeof value !== "bigint" &&
		!(typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value))
	)
		return invalid();
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 0) return invalid();
	return result;
}

// Caller supplies the authenticated PAT transaction and its established SQL user context.
export async function readApiAccountSetupStatus(
	client: PoolClient,
	actor: ApiActor,
): Promise<Response> {
	if (!PUBLIC_API_ID.safeParse(actor.userId).success)
		throw new PublicApiError(
			401,
			"inactive-user",
			"Authenticated user is unavailable",
		);
	const context = await client.query<{ userId: unknown }>(
		`select current_setting('ditero.user_id',true) as "userId"`,
	);
	if (context.rowCount !== 1 || context.rows[0].userId !== actor.userId)
		throw new PublicApiError(
			500,
			"invalid-user-context",
			"Account setup requires the caller SQL context",
		);
	const result = await client.query<Record<string, unknown>>(
		`select u.id as "userId",u.email,
 exists(select 1 from managed_account m where m.user_id=u.id) as managed,
 s.id as "setupId",s.outcome,s.revision,s.catalog_version as "catalogVersion",s.locale,
 s.latest_receipt as receipt,s.generated_ids as "generatedIds"
 from "user" u left join account_setup s on s.id=u.id
 where u.id=$1 and u.deleted_at is null`,
		[actor.userId],
	);
	if (result.rowCount !== 1 || result.rows[0].userId !== actor.userId)
		throw new PublicApiError(
			401,
			"inactive-user",
			"Authenticated user is unavailable",
		);
	const row = result.rows[0];
	if (typeof row.email !== "string" || typeof row.managed !== "boolean")
		return invalid();
	const missing = row.setupId === null;
	if (
		missing &&
		[
			row.outcome,
			row.revision,
			row.catalogVersion,
			row.locale,
			row.receipt,
			row.generatedIds,
		].some((value) => value !== null)
	)
		return invalid();
	if (!missing && row.setupId !== actor.userId) return invalid();
	const stored = accountSetupStoredStateSchema.safeParse(
		missing
			? {
					state: { outcome: "pending", revision: 0, receipt: null },
					catalogVersion: null,
					locale: null,
					generatedIds: null,
				}
			: {
					state: {
						outcome: row.outcome,
						revision: revision(row.revision),
						receipt: row.receipt,
					},
					catalogVersion: row.catalogVersion,
					locale: row.locale,
					generatedIds: row.generatedIds,
				},
	);
	if (!stored.success) return invalid();
	const managed =
		row.managed ||
		row.email.trim().toLowerCase().split("@").at(-1) === "managed.invalid";
	const response = accountSetupStatusResponseSchema.parse({
		version: PUBLIC_API_VERSION,
		data: deriveAccountSetupStatus(stored.data.state, managed),
		nextCursor: null,
	});
	return apiResult(response.data, response.nextCursor);
}
