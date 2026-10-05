import { describe, expect, test } from "vitest";
import { PublicApiError } from "./public-api.ts";
import {
	bindWebhookTask,
	canonicalWebhookDelivery,
	parseWebhookCreate,
	parseWebhookDelivery,
	validWebhookSecret,
	webhookBearer,
} from "./public-api-webhook.ts";
import { canonicalApiTaskCreate } from "./public-api-writes.ts";

const deliveryId = "6f1c2b0e-3f5a-4d7e-9a1b-0c2d3e4f5a6b";
const secret = `ditero_whk_${"a".repeat(43)}`;

describe("webhook credentials", () => {
	test("accept only the webhook bearer shape", () => {
		expect(validWebhookSecret(secret)).toBe(true);
		expect(validWebhookSecret(`ditero_pat_${"a".repeat(43)}`)).toBe(false);
		expect(validWebhookSecret(`${secret}x`)).toBe(false);
		const headers = (value: string) => new Headers({ authorization: value });
		expect(webhookBearer(headers(`Bearer ${secret}`))).toBe(secret);
		expect(webhookBearer(headers(`Bearer ditero_pat_${"a".repeat(43)}`))).toBe(
			null,
		);
		expect(webhookBearer(headers(secret))).toBe(null);
		expect(webhookBearer(new Headers())).toBe(null);
	});
});

describe("webhook management input", () => {
	test("is strict and bounded", () => {
		expect(parseWebhookCreate({ name: " Inbox ", listId: "l1" })).toEqual({
			name: "Inbox",
			listId: "l1",
			expiresInDays: 90,
		});
		for (const input of [
			{ name: "x", listId: "l1", expiresInDays: 0 },
			{ name: "x", listId: "l1", expiresInDays: 366 },
			{ name: "", listId: "l1" },
			{ name: "x", listId: "l1", workspaceId: "w" },
		])
			expect(() => parseWebhookCreate(input)).toThrow(PublicApiError);
	});
});

describe("webhook delivery input", () => {
	test("applies task-create defaults and no relationships", () => {
		const parsed = parseWebhookDelivery({
			deliveryId: deliveryId.toUpperCase(),
			title: "Pay invoice",
		});
		expect(parsed.deliveryId).toBe(deliveryId);
		expect(bindWebhookTask(parsed.task, "list-1")).toMatchObject({
			listId: "list-1",
			notes: null,
			dueAt: null,
			dueAllDay: false,
			priority: 0,
			assigneeIds: [],
			labelIds: [],
		});
	});

	test("rejects unknown fields and task-limit violations", () => {
		const base = { deliveryId, title: "Task" };
		for (const extra of [
			{ listId: "other" },
			{ assigneeIds: [] },
			{ labelIds: [] },
			{ parentId: "p" },
			{ title: "   " },
			{ title: "x".repeat(501) },
			{ priority: 4 },
			{ dueAllDay: true },
			{ dueAt: "tomorrow" },
		])
			expect(() => parseWebhookDelivery({ ...base, ...extra })).toThrow(
				PublicApiError,
			);
		expect(() => parseWebhookDelivery({ title: "Task" })).toThrow(
			PublicApiError,
		);
		expect(() => parseWebhookDelivery([])).toThrow(PublicApiError);
	});
});

describe("webhook request hash", () => {
	test("is separated from task create and bound to the webhook", () => {
		const { task } = parseWebhookDelivery({ deliveryId, title: "Task" });
		const bound = bindWebhookTask(task, "list-1");
		const first = canonicalWebhookDelivery("hook-a", bound);
		expect(first).not.toBe(canonicalApiTaskCreate(bound));
		expect(first).not.toBe(canonicalWebhookDelivery("hook-b", bound));
		expect(first).toBe(canonicalWebhookDelivery("hook-a", bound));
		expect(first).not.toBe(
			canonicalWebhookDelivery("hook-a", { ...bound, title: "Other" }),
		);
	});
});
