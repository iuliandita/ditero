import { z } from "zod";
import {
	webhookCreatedSchema,
	webhookCreateSchema,
	webhookMetadataSchema,
	webhookRevokedSchema,
} from "../domain/public-api-webhook.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestWebhookJson } from "./client.ts";
import { safeListInput } from "./list-workflow.ts";
import { readStdin, type StdinReader } from "./task-workflow.ts";

export const WEBHOOK_COMMANDS = [
	"list-webhooks",
	"create-webhook",
	"revoke-webhook",
];
export const MAX_WEBHOOK_INPUT_BYTES = 4096;
// The API lists at most 100 rows without pagination; the server owns expiry
// and active-hook policy, so the client only enforces schema and row cap.
const MAX_WEBHOOK_ROWS = 100;

function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide one strict webhook JSON object within 4 KiB: name (1-80 characters), listId and optional expiresInDays (1-365).",
		2,
	);
}

function invalidResponse(created = false): never {
	throw new CliError(
		"invalid_response",
		created
			? "The server returned an invalid or mismatched webhook response and its secret was discarded. List webhooks and revoke any unexpected one."
			: "The server returned an invalid or mismatched webhook response.",
		8,
	);
}

function envelope<S extends z.ZodType>(data: S) {
	return z
		.object({ version: z.literal(1), data, nextCursor: z.null() })
		.strict();
}

export async function webhookWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	const creating = options.command === "create-webhook";
	const revoking = options.command === "revoke-webhook";
	if (!WEBHOOK_COMMANDS.includes(options.command)) invalidInput();
	if (creating && options.revealSecret !== true)
		throw new CliError(
			"reveal_required",
			"The webhook secret is shown once. Pass --reveal-secret and keep the output private.",
			2,
		);
	let webhookId: string | undefined;
	if (revoking) {
		const parsed = z.uuid().safeParse(options.webhookId);
		if (!parsed.success) invalidInput();
		webhookId = parsed.data.toLowerCase();
	}
	let body: z.output<typeof webhookCreateSchema> | undefined;
	if (creating) {
		try {
			const bytes = await reader();
			if (!bytes.length || bytes.length > MAX_WEBHOOK_INPUT_BYTES)
				invalidInput();
			const raw: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
			if (!safeListInput(raw)) invalidInput();
			body = webhookCreateSchema.parse(raw);
		} catch {
			invalidInput();
		}
	}
	const path = revoking ? `/api/v1/webhooks/${webhookId}` : "/api/v1/webhooks";
	const result = await requestWebhookJson(
		options,
		new URL(path, options.server),
		fetcher,
		{
			method: creating ? "POST" : revoking ? "DELETE" : "GET",
			body: body && JSON.stringify(body),
		},
		signal,
	);
	if (creating) {
		const parsed = envelope(webhookCreatedSchema).safeParse(result);
		if (
			!parsed.success ||
			!body ||
			parsed.data.data.name !== body.name ||
			parsed.data.data.listId !== body.listId ||
			parsed.data.data.revokedAt !== null
		)
			invalidResponse(true);
		return parsed.data;
	}
	if (revoking) {
		const parsed = envelope(webhookRevokedSchema).safeParse(result);
		if (!parsed.success || parsed.data.data.id.toLowerCase() !== webhookId)
			invalidResponse();
		return parsed.data;
	}
	const parsed = envelope(
		z.array(webhookMetadataSchema).max(MAX_WEBHOOK_ROWS),
	).safeParse(result);
	if (!parsed.success) invalidResponse();
	return parsed.data;
}
