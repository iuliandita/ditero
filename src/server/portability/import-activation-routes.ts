import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { ActivationTransitionConflict } from "../../zero/task-activation-transition.ts";
import type { Guards } from "../guards.ts";
import {
	finishTaskActivation,
	ImportRecoveryError,
	reviewTaskActivation,
} from "./import-activation-recovery.ts";
import { ImportPlanStoreError } from "./import-plan-store.ts";

const headers = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};
const confirmationSchema = z.strictObject({
	reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
	confirm: z.literal(true),
});

function taskId(request: Request): string {
	const parts = new URL(request.url).pathname.split("/");
	const id = parts.at(-2) ?? "";
	if (!/^[a-zA-Z0-9-]{1,128}$/.test(id))
		throw new ImportRecoveryError("not-found", 404);
	return id;
}

function reply(body: unknown, status = 200) {
	return Response.json(body, { status, headers });
}

async function readSmallJson(request: Request): Promise<unknown> {
	if (!request.body) throw new ImportRecoveryError("invalid-request", 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_, reject) => {
		abort = () => reject(new ImportRecoveryError("request-cancelled", 408));
		request.signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => reject(new ImportRecoveryError("request-timeout", 408)),
			5_000,
		);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), interrupted]);
			if (result.done) break;
			bytes += result.value.byteLength;
			if (bytes > 4096) throw new ImportRecoveryError("request-limit", 413);
			chunks.push(result.value);
		}
		const combined = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(combined),
		);
	} catch (error) {
		if (error instanceof ImportRecoveryError) throw error;
		throw new ImportRecoveryError("invalid-request", 400);
	} finally {
		clearTimeout(timer);
		if (abort) request.signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function handled(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ImportRecoveryError)
			return reply({ code: error.code }, error.status);
		if (error instanceof ImportPlanStoreError)
			return reply({ code: error.code }, error.status);
		if (error instanceof ActivationTransitionConflict)
			return reply({ code: "activation-review-stale" }, 409);
		const code =
			error &&
			typeof error === "object" &&
			"code" in error &&
			["57014", "55P03", "40P01"].includes(String(error.code))
				? "activation-retry"
				: "activation-recovery-failed";
		if (code === "activation-recovery-failed")
			console.error("activation recovery failed", { category: "unexpected" });
		return reply({ code }, code === "activation-retry" ? 503 : 500);
	}
}

export function importActivationRoutes(pool: Pool, guards: Guards) {
	return new Elysia()
		.get(
			"/api/portability/import/tasks/:taskId/activation-review",
			guards.guardedGet((request, session) =>
				handled(async () => {
					const rawPage = new URL(request.url).searchParams.get("page");
					const page = rawPage === null ? 0 : Number(rawPage);
					const review = await reviewTaskActivation(
						pool,
						session.user.id,
						taskId(request),
						page,
						{ signal: request.signal, deadline: performance.now() + 20_000 },
					);
					return reply(review);
				}),
			),
		)
		.post(
			"/api/portability/import/tasks/:taskId/finish",
			guards.guardedPost((request, session) =>
				handled(async () => {
					if (
						(request.headers.get("content-type") ?? "")
							.split(";")[0]
							?.trim()
							.toLowerCase() !== "application/json"
					)
						return reply({ code: "invalid-request" }, 415);
					const declared = request.headers.get("content-length");
					if (
						declared !== null &&
						(!/^\d+$/.test(declared) || Number(declared) > 4096)
					)
						return reply({ code: "request-limit" }, 413);
					const parsed = await readSmallJson(request);
					const confirmation = confirmationSchema.safeParse(parsed);
					if (!confirmation.success)
						return reply({ code: "invalid-confirmation" }, 400);
					const result = await finishTaskActivation(
						pool,
						session.user.id,
						taskId(request),
						confirmation.data.reviewDigest,
						{ signal: request.signal, deadline: performance.now() + 20_000 },
					);
					return reply(result);
				}),
			),
			{ parse: "none" },
		);
}
