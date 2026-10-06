import { z } from "zod";
import { LOCALES } from "./locale.ts";

export const ACCOUNT_SETUP_CATALOG_VERSION = 1;
export const ACCOUNT_SETUP_STARTERS = [
	"shopping",
	"packing",
	"cleaning",
] as const;
export const accountSetupOutcomeSchema = z.enum([
	"pending",
	"completed",
	"custom",
	"skipped",
	"legacy",
]);
const revision = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER - 1);
const starter = z.enum(ACCOUNT_SETUP_STARTERS);
const common = {
	requestId: z.string().uuid(),
	expectedRevision: revision,
	catalogVersion: z.literal(ACCOUNT_SETUP_CATALOG_VERSION),
	locale: z.enum(LOCALES),
};
const starterKeys = z
	.array(starter)
	.max(3)
	.refine((keys) => new Set(keys).size === keys.length, "Duplicate starter")
	.transform((keys) =>
		ACCOUNT_SETUP_STARTERS.filter((key) => keys.includes(key)),
	);
export const accountSetupRequestSchema = z.discriminatedUnion("mode", [
	z.object({ ...common, mode: z.literal("basic") }).strict(),
	z
		.object({
			...common,
			mode: z.literal("guided"),
			starterKeys,
			dashboard: z.boolean(),
		})
		.strict()
		.refine(
			(input) => input.starterKeys.length > 0 || input.dashboard,
			"Choose content or Custom",
		),
	z.object({ ...common, mode: z.literal("custom") }).strict(),
	z.object({ ...common, mode: z.literal("skip") }).strict(),
]);
export type AccountSetupRequest = z.infer<typeof accountSetupRequestSchema>;
export type AccountSetupOutcome = z.infer<typeof accountSetupOutcomeSchema>;

export function accountSetupSelection(request: AccountSetupRequest) {
	if (request.mode === "basic")
		return {
			starterKeys: ["shopping", "cleaning"] as Array<
				(typeof ACCOUNT_SETUP_STARTERS)[number]
			>,
			dashboard: true,
		};
	if (request.mode === "guided")
		return {
			starterKeys: [...request.starterKeys],
			dashboard: request.dashboard,
		};
	return {
		starterKeys: [] as Array<(typeof ACCOUNT_SETUP_STARTERS)[number]>,
		dashboard: false,
	};
}

// This is a bounded canonical request identity, not a cryptographic digest.
export function accountSetupRequestSignature(
	input: AccountSetupRequest,
): string {
	const request = accountSetupRequestSchema.parse(input);
	const selection = accountSetupSelection(request);
	return JSON.stringify([
		request.catalogVersion,
		request.locale,
		request.mode,
		request.expectedRevision,
		selection.starterKeys,
		selection.dashboard,
	]);
}

function outcome(request: AccountSetupRequest) {
	return request.mode === "custom"
		? "custom"
		: request.mode === "skip"
			? "skipped"
			: "completed";
}
export const accountSetupReceiptSchema = z
	.object({
		request: accountSetupRequestSchema,
		outcome: z.enum(["completed", "custom", "skipped"]),
		revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	})
	.strict()
	.refine(
		(receipt) =>
			receipt.outcome === outcome(receipt.request) &&
			receipt.revision === receipt.request.expectedRevision + 1,
		"Invalid setup receipt",
	);
export const accountSetupStateSchema = z
	.object({
		outcome: accountSetupOutcomeSchema,
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		receipt: accountSetupReceiptSchema.nullable(),
	})
	.strict()
	.refine(
		(state) =>
			state.receipt
				? state.outcome === state.receipt.outcome &&
					state.revision === state.receipt.revision
				: (state.outcome === "pending" || state.outcome === "legacy") &&
					state.revision === 0,
		"Invalid setup state",
	);
export type AccountSetupState = z.infer<typeof accountSetupStateSchema>;
export type AccountSetupReceipt = z.infer<typeof accountSetupReceiptSchema>;
export type AccountSetupConflictCode =
	| "request-conflict"
	| "already-completed"
	| "revision-conflict"
	| "apply-required";
export class AccountSetupConflict extends Error {
	constructor(public readonly code: AccountSetupConflictCode) {
		super(code);
		this.name = "AccountSetupConflict";
	}
}
export type AccountSetupTransition =
	| { kind: "replay"; receipt: AccountSetupReceipt }
	| {
			kind: "commit";
			state: AccountSetupState;
			selection: ReturnType<typeof accountSetupSelection>;
	  };

// Caller must lock/recheck authoritative state and atomically persist content + receipt.
export function planAccountSetupTransition(
	current: AccountSetupState,
	input: AccountSetupRequest,
): AccountSetupTransition {
	const state = accountSetupStateSchema.parse(current);
	const request = accountSetupRequestSchema.parse(input);
	if (state.receipt?.request.requestId === request.requestId) {
		if (
			accountSetupRequestSignature(state.receipt.request) !==
			accountSetupRequestSignature(request)
		)
			throw new AccountSetupConflict("request-conflict");
		return { kind: "replay", receipt: state.receipt };
	}
	if (state.outcome === "completed")
		throw new AccountSetupConflict("already-completed");
	if (state.revision !== request.expectedRevision)
		throw new AccountSetupConflict("revision-conflict");
	if (
		(state.outcome === "custom" || state.outcome === "skipped") &&
		request.mode !== "basic" &&
		request.mode !== "guided"
	)
		throw new AccountSetupConflict("apply-required");
	const receipt = {
		request,
		outcome: outcome(request),
		revision: state.revision + 1,
	};
	return {
		kind: "commit",
		state: accountSetupStateSchema.parse({
			outcome: receipt.outcome,
			revision: receipt.revision,
			receipt,
		}),
		selection: accountSetupSelection(request),
	};
}
