import { describe, expect, it } from "vitest";
import {
	assertZeroShardAccess,
	DEFAULT_ZERO_SHARD_SCHEMA,
	type ShardAccess,
	zeroShardSchema,
} from "./zero-shard.ts";

const usable: ShardAccess = {
	schema: "zero_0",
	schemaExists: true,
	schemaUsable: true,
	clientsWritable: true,
};

describe("zeroShardSchema", () => {
	it("defaults when unset", () => {
		expect(zeroShardSchema({})).toBe(DEFAULT_ZERO_SHARD_SCHEMA);
	});

	it("defaults when empty, so a blank compose value is not a schema name", () => {
		expect(zeroShardSchema({ DITERO_ZERO_SHARD_SCHEMA: "" })).toBe(
			DEFAULT_ZERO_SHARD_SCHEMA,
		);
	});

	it("honours an override", () => {
		expect(zeroShardSchema({ DITERO_ZERO_SHARD_SCHEMA: "myapp_0" })).toBe(
			"myapp_0",
		);
	});
});

describe("assertZeroShardAccess", () => {
	it("accepts a fully granted shard", () => {
		expect(() => assertZeroShardAccess(usable)).not.toThrow();
	});

	it("accepts a shard zero-cache has not created yet", () => {
		expect(() =>
			assertZeroShardAccess({
				...usable,
				schemaExists: false,
				schemaUsable: false,
				clientsWritable: null,
			}),
		).not.toThrow();
	});

	it("accepts a created schema whose tables do not exist yet", () => {
		expect(() =>
			assertZeroShardAccess({ ...usable, clientsWritable: null }),
		).not.toThrow();
	});

	it("rejects a schema the runtime role cannot use", () => {
		expect(() =>
			assertZeroShardAccess({
				...usable,
				schemaUsable: false,
				clientsWritable: null,
			}),
		).toThrow(/cannot use Zero's shard schema/);
	});

	it("rejects a clients table the runtime role cannot write", () => {
		expect(() =>
			assertZeroShardAccess({ ...usable, clientsWritable: false }),
		).toThrow(/write the clients table in/);
	});

	it("names the schema and the runbook so the operator can act on it", () => {
		expect(() =>
			assertZeroShardAccess({ ...usable, schemaUsable: false }),
		).toThrow(/"zero_0".*database-roles\.md/s);
	});
});
