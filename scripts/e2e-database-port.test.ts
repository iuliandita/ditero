import { expect, test } from "vitest";
import { e2eDatabaseURL } from "./e2e-database-port.ts";

test("uses the actual Docker loopback binding for the fixture database", () => {
	expect(e2eDatabaseURL("127.0.0.1:43219\n")).toBe(
		"postgres://postgres:pass@127.0.0.1:43219/ditero_e2e",
	);
});

test.each([
	"",
	"127.0.0.1:0",
	"127.0.0.1:65536",
	"0.0.0.0:43219",
	"[::1]:43219",
	"127.0.0.1:43219\n127.0.0.1:43220",
	"127.0.0.1:43219/other",
])("rejects ambiguous or non-loopback binding %s", (binding) => {
	expect(() => e2eDatabaseURL(binding)).toThrow("one loopback");
});
