import { describe, expect, test, vi } from "vitest";
import {
	deleteAttachment,
	fetchAttachmentConfig,
	fetchMyGrants,
} from "./attachment-api.ts";

describe("attachment API client", () => {
	test("validates the configured file limit", async () => {
		const fetcher = vi.fn(async () => Response.json({ maxFileBytes: 1234 }));

		await expect(fetchAttachmentConfig(fetcher)).resolves.toEqual({
			maxFileBytes: 1234,
		});
		expect(fetcher).toHaveBeenCalledWith(
			"/api/attachments/config",
			expect.objectContaining({ credentials: "include" }),
		);
	});

	test("keeps holder identities attached to their requested key version", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				requests: [
					{
						requestId: "request-1",
						workspaceId: "workspace-1",
						keyVersion: 3,
						state: "pending",
						failureReason: null,
						holders: [{ userId: "user-1", name: "Ada" }],
					},
				],
			}),
		);

		await expect(fetchMyGrants(fetcher)).resolves.toEqual([
			expect.objectContaining({
				workspaceId: "workspace-1",
				keyVersion: 3,
				holders: [{ userId: "user-1", name: "Ada" }],
			}),
		]);
	});

	test("soft-deletes through the dedicated endpoint", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ id: "attachment-1", state: "deleting" }),
		);

		await expect(deleteAttachment("attachment-1", fetcher)).resolves.toEqual({
			id: "attachment-1",
			state: "deleting",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"/api/attachments/delete",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ id: "attachment-1" }),
			}),
		);
	});
});
