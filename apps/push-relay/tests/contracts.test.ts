import { describe, expect, it } from "vitest";
import {
	canonical,
	credentialHash,
	id,
	opaque,
	schemas,
	semanticDigest,
} from "../src/contracts.ts";

describe("relay closed contracts", () => {
	it("accepts only canonical 32-byte identifiers", () => {
		expect(opaque.safeParse(id()).success).toBe(true);
		expect(opaque.safeParse("A".repeat(42)).success).toBe(false);
		expect(opaque.safeParse(`${"A".repeat(42)}B`).success).toBe(false);
	});
	it("separates capabilities by purpose", () => {
		const secret = id();
		expect(credentialHash("send", secret)).not.toBe(
			credentialHash("management", secret),
		);
	});
	it("ignores renewed authentication wrappers but binds every semantic field", () => {
		const body = {
			installationId: id(),
			targetId: id(),
			registrationId: id(),
			operationId: id(),
			generation: 1,
			sendCapability: id(),
			priority: "normal" as const,
			data: {
				version: "1" as const,
				notificationId: id(),
				registrationId: id(),
			},
		};
		expect(semanticDigest(body)).toBe(
			semanticDigest({
				...body,
				deviceProof: "renewed",
				appCheck: "renewed",
				senderProof: "renewed",
			}),
		);
		expect(semanticDigest({ ...body, generation: 2 })).not.toBe(
			semanticDigest(body),
		);
		expect(canonical({ z: 1, a: { b: 2, a: 1 } })).toBe(
			'{"a":{"a":1,"b":2},"z":1}',
		);
	});
	it("preserves existing application UUIDs", () => {
		const registrationId = "550e8400-e29b-41d4-a716-446655440000";
		expect(
			schemas["/v1/send"].safeParse({
				installationId: id(),
				targetId: id(),
				registrationId,
				operationId: id(),
				generation: 1,
				sendCapability: id(),
				priority: "normal",
				data: {
					version: "1",
					notificationId: "550e8400-e29b-41d4-a716-446655440001",
					registrationId,
				},
			}).success,
		).toBe(true);
	});
	it("rejects extra payload fields, private keys and mixed retirement authority", () => {
		const base = {
			installationId: id(),
			targetId: id(),
			registrationId: id(),
			operationId: id(),
			generation: 1,
		};
		expect(
			schemas["/v1/send"].safeParse({
				...base,
				sendCapability: id(),
				priority: "normal",
				data: {
					version: "1",
					notificationId: id(),
					registrationId: base.registrationId,
					title: "private",
				},
			}).success,
		).toBe(false);
		expect(
			schemas["/v1/manage/retire"].safeParse({
				...base,
				managementSecret: id(),
				sendCapability: id(),
			}).success,
		).toBe(false);
	});
});
