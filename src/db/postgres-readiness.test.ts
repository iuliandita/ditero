import { Socket } from "node:net";
import { expect, test, vi } from "vitest";
import {
	postgresReadinessCode,
	waitForPostgres,
} from "./postgres-readiness.ts";

test.each([
	"ECONNREFUSED",
	"57P03",
	"28P01",
	"ERR_TLS_CERT_ALTNAME_INVALID",
])("retains the exact error code %s without using its message", (code) => {
	expect(
		postgresReadinessCode({ code, message: "private connection details" }),
	).toBe(code);
});
test.each([
	null,
	new Error("ECONNREFUSED"),
	{ code: 1 },
	{ code: "secret://host" },
])("does not infer readiness from untrusted error messages or malformed codes", (error) => {
	expect(postgresReadinessCode(error)).toBe("UNKNOWN");
});
test.each([
	{ timeoutMs: 30_001 },
	{ timeoutMs: 0 },
	{ attemptTimeoutMs: 0 },
	{ backoffMs: 0 },
	{ timeoutMs: NaN },
])("rejects invalid or unbounded budgets before connecting", async (options) => {
	await expect(waitForPostgres("private-invalid-url", options)).rejects.toThrow(
		"Invalid PostgreSQL readiness budget",
	);
});
test("an already aborted operation never opens a connection", async () => {
	await expect(
		waitForPostgres("private-invalid-url", { signal: AbortSignal.abort() }),
	).rejects.toMatchObject({ code: "ABORT_ERR" });
});
test.each([
	"invalid",
	"-1",
	"65536",
])("invalid parsed port %s fails before connecting", async (port) => {
	const connect = vi.spyOn(Socket.prototype, "connect");
	try {
		await expect(
			waitForPostgres(`postgres://localhost/db?port=${port}`, {
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
		expect(connect).not.toHaveBeenCalled();
	} finally {
		connect.mockRestore();
	}
});
test("synchronous connect failure closes without relying on pg's unattached end handler", async () => {
	const connect = vi
		.spyOn(Socket.prototype, "connect")
		.mockImplementationOnce(() => {
			throw Object.assign(new Error("Private connection details"), {
				code: "ERR_INVALID_ARG_TYPE",
			});
		});
	try {
		await expect(
			waitForPostgres("postgres://localhost/db", { timeoutMs: 100 }),
		).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
		expect(connect).toHaveBeenCalledOnce();
	} finally {
		connect.mockRestore();
	}
});
