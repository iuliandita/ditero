import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProtectedFetch } from "../src/app-check.ts";
import { id } from "../src/contracts.ts";
import { createFcmSender, FCM_SCOPE, OAUTH_URL } from "../src/fcm.ts";

const account = {
	projectId: "relay-fixture",
	clientEmail: "fixture@relay-fixture.iam.gserviceaccount.com",
	privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};
describe("FCM protected submission", () => {
	it("uses explicit fid, minimal data, normal challenge priority, TTL and narrow OAuth scope", async () => {
		let count = 0;
		const data = {
			version: "1" as const,
			notificationId: id(),
			registrationId: id(),
		};
		const transport: ProtectedFetch = async (url, options) => {
			count++;
			expect(options?.maxResponseBytes).toBe(16384);
			if (url === OAUTH_URL) {
				const assertion = new URLSearchParams(options?.body as string).get(
					"assertion",
				) as string;
				expect(
					JSON.parse(
						Buffer.from(assertion.split(".")[1], "base64url").toString(),
					).scope,
				).toBe(FCM_SCOPE);
				return Response.json({
					access_token: "opaque-access",
					token_type: "Bearer",
					expires_in: 3600,
				});
			}
			expect(url).toBe(
				"https://fcm.googleapis.com/v1/projects/relay-fixture/messages:send",
			);
			expect(JSON.parse(options?.body as string)).toEqual({
				message: {
					fid: "installation-fid",
					data,
					android: { priority: "normal", ttl: "300s" },
				},
			});
			return Response.json({
				name: "projects/relay-fixture/messages/accepted",
			});
		};
		const send = createFcmSender(account, transport);
		expect(
			await send("installation-fid", data, "normal", AbortSignal.timeout(1000)),
		).toEqual({ kind: "accepted" });
		expect(
			await send("installation-fid", data, "normal", AbortSignal.timeout(1000)),
		).toEqual({ kind: "accepted" });
		expect(count).toBe(3);
	});
	it.each([
		[404, "UNREGISTERED", "stale"],
		[404, "NOT_FOUND", "permanent"],
		[429, "QUOTA_EXCEEDED", "quota"],
		[503, "UNAVAILABLE", "retryable"],
		[403, "PERMISSION_DENIED", "permanent"],
	])("classifies %s %s", async (status, code, kind) => {
		const send = createFcmSender(account, async (url) =>
			url === OAUTH_URL
				? Response.json({
						access_token: "opaque-access",
						token_type: "Bearer",
						expires_in: 3600,
					})
				: Response.json(
						{
							error: {
								details: [
									{
										"@type":
											"type.googleapis.com/google.firebase.fcm.v1.FcmError",
										errorCode: code,
									},
								],
							},
						},
						{ status: status as number },
					),
		);
		expect(
			await send(
				"installation-fid",
				{ version: "1", notificationId: id(), registrationId: id() },
				"high",
				AbortSignal.timeout(1000),
			),
		).toEqual({ kind });
	});
	it("bounds malformed and oversized provider responses", async () => {
		const send = createFcmSender(account, async (url) =>
			url === OAUTH_URL
				? Response.json({
						access_token: "opaque-access",
						token_type: "Bearer",
						expires_in: 3600,
					})
				: new Response("x".repeat(16385)),
		);
		expect(
			(
				await send(
					"installation-fid",
					{ version: "1", notificationId: id(), registrationId: id() },
					"normal",
					AbortSignal.timeout(1000),
				)
			).kind,
		).toBe("retryable");
	});
});
