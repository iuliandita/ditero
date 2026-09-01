import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import {
	claimFastInvite,
	FastInviteError,
	type FastInviteFailure,
	finalizeFastInvite,
	grantFastInvite,
} from "../../auth/invite-fast-path.ts";
import { e2eEnabled } from "../../config/e2e.ts";
import type { db as defaultDb } from "../../db/client.ts";
import type { Guards } from "../guards.ts";
import { notifyGrantCapable } from "./grants.ts";
import { e2eBlobSchema, e2ePublicKeySchema } from "./input.ts";

const token = z.string().min(1).max(256);
const claimBody = z.object({ token });
const grantBody = z.object({
	token,
	requestId: z.string().min(1).max(128),
	recipientPublicKey: e2ePublicKeySchema,
	enc: e2eBlobSchema,
	ciphertext: e2eBlobSchema,
});
const finalizeBody = z.object({
	token,
	mode: z.enum(["fast", "fallback"]),
});

const STATUS: Record<FastInviteFailure, number> = {
	not_found: 404,
	expired: 410,
	exhausted: 410,
	revoked: 410,
	email_mismatch: 403,
	not_fast_eligible: 409,
	not_claimed: 409,
	grant_pending: 409,
	stale_recipient_key: 409,
	conflict: 409,
};

async function parsedBody<T>(
	request: Request,
	schema: z.ZodType<T>,
): Promise<T | Response> {
	try {
		return schema.parse(await request.json());
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
}

function fastInviteFailure(error: unknown): Response | null {
	if (!(error instanceof FastInviteError)) return null;
	return new Response(error.reason, { status: STATUS[error.reason] });
}

export function e2eInviteRoutes(
	pool: Pool,
	database: typeof defaultDb,
	guards: Guards,
) {
	return new Elysia()
		.post(
			"/api/invite/claim",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const parsed = await parsedBody(request, claimBody);
				if (parsed instanceof Response) return parsed;
				try {
					return await claimFastInvite(
						pool,
						parsed.token,
						session.user.id,
						session.user.email,
					);
				} catch (error) {
					const failure = fastInviteFailure(error);
					if (failure) return failure;
					throw error;
				}
			}),
		)
		.post(
			"/api/invite/grant",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const parsed = await parsedBody(request, grantBody);
				if (parsed instanceof Response) return parsed;
				try {
					const outcome = await grantFastInvite(pool, session.user.id, parsed);
					return { requestId: parsed.requestId, outcome };
				} catch (error) {
					const failure = fastInviteFailure(error);
					if (failure) return failure;
					throw error;
				}
			}),
		)
		.post(
			"/api/invite/finalize",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const parsed = await parsedBody(request, finalizeBody);
				if (parsed instanceof Response) return parsed;
				try {
					const result = await finalizeFastInvite(
						pool,
						parsed.token,
						session.user.id,
						parsed.mode,
					);
					if (parsed.mode === "fallback" && result.grantRequestId) {
						await notifyGrantCapable(database, result.grantRequestId).catch(
							(error: unknown) => {
								console.error("e2e: grant notification failed:", error);
							},
						);
					}
					return { workspaceId: result.workspaceId };
				} catch (error) {
					const failure = fastInviteFailure(error);
					if (failure) return failure;
					throw error;
				}
			}),
		);
}
