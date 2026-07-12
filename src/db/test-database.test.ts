import { describe, expect, test } from "vitest";
import { assertSafeTestDatabase } from "./test-database.ts";

const TEST_URL = "postgres://postgres:pass@localhost:55432/ditero_e2e";

describe("assertSafeTestDatabase", () => {
	test("accepts the isolated E2E database in test mode", () => {
		expect(() => assertSafeTestDatabase(TEST_URL, "test")).not.toThrow();
	});

	test.each([
		["production mode", TEST_URL, "production"],
		["development mode", TEST_URL, "development"],
		[
			"application database",
			"postgres://postgres:pass@localhost/ditero",
			"test",
		],
		[
			"another test database",
			"postgres://postgres:pass@localhost/other_test",
			"test",
		],
		["malformed DSN", "not-a-url", "test"],
	])("rejects %s", (_case, databaseURL, nodeEnv) => {
		expect(() => assertSafeTestDatabase(databaseURL, nodeEnv)).toThrow(
			/refusing destructive E2E seed/i,
		);
	});
});
