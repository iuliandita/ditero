import { z } from "zod";
import { accountSetupStateSchema } from "./account-setup.ts";
import { LOCALES } from "./locale.ts";

const uuid = z.string().uuid().max(64);
export const accountSetupGeneratedIdsSchema = z
	.object({
		version: z.literal(1),
		workspaceId: uuid,
		listIds: z.array(uuid).max(3),
		taskIds: z.array(uuid).max(24),
		panelIds: z.array(uuid).max(2),
		dashboardId: uuid.nullable(),
	})
	.strict()
	.refine((value) => {
		const ids = [
			value.workspaceId,
			...value.listIds,
			...value.taskIds,
			...value.panelIds,
			...(value.dashboardId ? [value.dashboardId] : []),
		].map((id) => id.toLowerCase());
		return new Set(ids).size === ids.length;
	}, "Duplicate setup content ID");
export type AccountSetupGeneratedIds = z.infer<
	typeof accountSetupGeneratedIdsSchema
>;
export const accountSetupStoredStateSchema = z
	.object({
		state: accountSetupStateSchema,
		catalogVersion: z.literal(1).nullable(),
		locale: z.enum(LOCALES).nullable(),
		generatedIds: accountSetupGeneratedIdsSchema.nullable(),
	})
	.strict()
	.refine((stored) => {
		const receipt = stored.state.receipt;
		if (!receipt)
			return (
				stored.catalogVersion === null &&
				stored.locale === null &&
				stored.generatedIds === null
			);
		return (
			stored.catalogVersion === receipt.request.catalogVersion &&
			stored.locale === receipt.request.locale &&
			(stored.state.outcome === "completed"
				? stored.generatedIds !== null
				: stored.generatedIds === null)
		);
	}, "Invalid stored setup state");
export type AccountSetupStoredState = z.infer<
	typeof accountSetupStoredStateSchema
>;
