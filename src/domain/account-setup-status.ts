import { z } from "zod";
import {
	ACCOUNT_SETUP_CATALOG_VERSION,
	type AccountSetupState,
	accountSetupOutcomeSchema,
	accountSetupStateSchema,
} from "./account-setup.ts";
import { PUBLIC_API_VERSION } from "./public-api.ts";

// Stable setup capability; callers navigate locally rather than accepting a supplied URL.
export const ACCOUNT_SETUP_PATH = "/setup";
export const accountSetupStatusSchema = z
	.object({
		outcome: accountSetupOutcomeSchema,
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		eligibility: z.enum(["available", "managed"]),
		catalogVersion: z.literal(ACCOUNT_SETUP_CATALOG_VERSION),
		setupPath: z.literal(ACCOUNT_SETUP_PATH),
	})
	.strict()
	.refine(
		(status) =>
			status.outcome === "pending" || status.outcome === "legacy"
				? status.revision === 0
				: status.revision > 0,
		"Invalid setup status",
	);
export type AccountSetupStatus = z.infer<typeof accountSetupStatusSchema>;
export const accountSetupStatusResponseSchema = z
	.object({
		version: z.literal(PUBLIC_API_VERSION),
		data: accountSetupStatusSchema,
		nextCursor: z.null(),
	})
	.strict();
export type AccountSetupStatusResponse = z.infer<
	typeof accountSetupStatusResponseSchema
>;

export function deriveAccountSetupStatus(
	current: AccountSetupState,
	managed: boolean,
): AccountSetupStatus {
	const state = accountSetupStateSchema.parse(current);
	return accountSetupStatusSchema.parse({
		outcome: state.outcome,
		revision: state.revision,
		eligibility: z.boolean().parse(managed) ? "managed" : "available",
		catalogVersion: ACCOUNT_SETUP_CATALOG_VERSION,
		setupPath: ACCOUNT_SETUP_PATH,
	});
}
