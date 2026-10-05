import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import { type ApiTaskCreate, parseApiTaskCreate } from "./public-api-writes.ts";

export const WEBHOOK_PREFIX = "ditero_whk_";
export const WEBHOOK_ACTIVE_LIMIT = 20;
export const WEBHOOK_DELIVERY_MAX_BYTES = 4096;
// Placeholder until the stored hook binds the list; callers must use bindWebhookTask.
const UNBOUND_LIST = "unbound";

const SECRET = /^ditero_whk_[A-Za-z0-9_-]{43}$/;
const BEARER = /^[Bb]earer (ditero_whk_[A-Za-z0-9_-]{43})$/;

export function validWebhookSecret(secret: string): boolean {
	return SECRET.test(secret);
}

// Only the Authorization header carries the credential; PAT-shaped values never match.
export function webhookBearer(headers: Headers): string | null {
	return headers.get("authorization")?.match(BEARER)?.[1] ?? null;
}

export const webhookCreateSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.refine(
				(value) =>
					value.isWellFormed() &&
					!Array.from(value).some((character) => {
						const code = character.codePointAt(0) ?? 0;
						return code < 32 || (code >= 127 && code <= 159);
					}),
			),
		listId: PUBLIC_API_ID,
		expiresInDays: z.number().int().min(1).max(365).default(90),
	})
	.strict();

export function parseWebhookCreate(input: unknown) {
	const parsed = webhookCreateSchema.safeParse(input);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-webhook-request",
			"Invalid webhook name, list or lifetime",
		);
	return parsed.data;
}

export const webhookDeliverySchema = z
	.object({
		deliveryId: z.uuid(),
		title: z.string(),
		notes: z.string().nullable().optional(),
		dueAt: z.string().nullable().optional(),
		dueAllDay: z.boolean().optional(),
		priority: z.number().optional(),
	})
	.strict();

export type WebhookDelivery = { deliveryId: string; task: ApiTaskCreate };

export function parseWebhookDelivery(input: unknown): WebhookDelivery {
	const parsed = webhookDeliverySchema.safeParse(input);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-webhook-delivery",
			"Invalid webhook delivery fields",
		);
	const { deliveryId, ...fields } = parsed.data;
	const defined = Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
	try {
		// Task limits and defaults stay owned by the task-create contract.
		const task = parseApiTaskCreate({ ...defined, listId: UNBOUND_LIST });
		return { deliveryId: deliveryId.toLowerCase(), task };
	} catch {
		throw new PublicApiError(
			400,
			"invalid-webhook-delivery",
			"Invalid webhook delivery fields",
		);
	}
}

export function bindWebhookTask(
	task: ApiTaskCreate,
	listId: string,
): ApiTaskCreate {
	return { ...task, listId, assigneeIds: [], labelIds: [] };
}

// Domain-separated from task.create.v1 and bound to the hook, so a reused UUID
// through the PAT endpoint or another hook conflicts instead of replaying.
export function canonicalWebhookDelivery(
	webhookId: string,
	task: ApiTaskCreate,
): string {
	return JSON.stringify({
		operation: "webhook.task.create.v1",
		webhookId,
		...task,
	});
}

export const webhookMetadataSchema = z
	.object({
		id: z.uuid(),
		name: z.string(),
		hint: z.string().length(4),
		listId: PUBLIC_API_ID,
		workspaceId: PUBLIC_API_ID,
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
		revokedAt: z.iso.datetime().nullable(),
	})
	.strict();

export const webhookCreatedSchema = webhookMetadataSchema
	.extend({ secret: z.string().regex(SECRET) })
	.strict();

export const webhookRevokedSchema = z
	.object({ id: z.uuid(), revoked: z.literal(true) })
	.strict();

export const webhookDeliveryAckSchema = z
	.object({ id: PUBLIC_API_ID, listId: PUBLIC_API_ID, replayed: z.boolean() })
	.strict();
