import { describe, expect, it } from "vitest";
import {
	ClientError,
	getErrorConnectionTransition,
} from "../../../node_modules/@rocicorp/zero/out/zero-client/src/client/error.js";
import {
	errorBodySchema,
	ProtocolError,
} from "../../../node_modules/@rocicorp/zero/out/zero-protocol/src/error.js";

// Exercise the installed package so a missing/obsolete Bun patch fails here.
const failure = (
	kind: "PushFailed" | "TransformFailed",
	fields: Record<string, unknown>,
) =>
	new ProtocolError(
		errorBodySchema.parse(
			{
				kind,
				message: "outage",
				mutationIDs: [],
				queryIDs: [],
				...fields,
			},
			{ mode: "passthrough" },
		),
	);

describe.each([
	"PushFailed",
	"TransformFailed",
] as const)("Zero %s recovery", (kind) => {
	it.each([
		{ origin: "zeroCache", reason: "http", status: 500 },
		{ origin: "zeroCache", reason: "http", status: 502 },
		{ origin: "zeroCache", reason: "http", status: 503 },
		{ origin: "zeroCache", reason: "http", status: 504 },
		{ origin: "zeroCache", reason: "timeout" },
		{
			origin: "zeroCache",
			reason: "internal",
			message: "Fetch from API server threw error: fetch failed",
		},
		{ origin: "server", reason: "database" },
	])("keeps transient failure %j on the reconnect loop", (fields) => {
		expect(getErrorConnectionTransition(failure(kind, fields)).status).toBe(
			"NO_STATUS_TRANSITION",
		);
	});

	it.each([401, 403])("still requires authentication for HTTP %s", (status) => {
		expect(
			getErrorConnectionTransition(
				failure(kind, { origin: "zeroCache", reason: "http", status }),
			).status,
		).toBe("needs-auth");
	});

	it.each([
		{ origin: "zeroCache", reason: "http", status: 400 },
		{ origin: "zeroCache", reason: "http", status: 404 },
		{ origin: "zeroCache", reason: "parse" },
		{ origin: "zeroCache", reason: "internal", message: "URL is not allowed" },
		{ origin: "server", reason: "parse" },
		{ origin: "server", reason: "internal" },
	])("still stops on permanent failure %j", (fields) => {
		expect(getErrorConnectionTransition(failure(kind, fields)).status).toBe(
			"error",
		);
	});
});

it("does not revive an explicitly closed client or bypass invalid credentials", () => {
	expect(
		getErrorConnectionTransition(
			new ClientError({ kind: "ClientClosed", message: "closed" }),
		).status,
	).toBe("closed");
	for (const kind of ["Unauthorized", "AuthInvalidated"] as const)
		expect(
			getErrorConnectionTransition(
				new ProtocolError({ kind, origin: "zeroCache", message: "invalid" }),
			).status,
		).toBe("needs-auth");
});

it.each([
	"getaddrinfo ENOTFOUND database",
	"getaddrinfo EAI_AGAIN database",
	"connect ECONNREFUSED 192.0.2.1:5432",
	"write CONNECTION_CLOSED database:5432",
	"Connection terminated unexpectedly",
	"the database system is starting up",
	"the database system is shutting down",
])("retries cache database connectivity failure: %s", (message) => {
	expect(
		getErrorConnectionTransition(
			new ProtocolError({ kind: "Internal", origin: "zeroCache", message }),
		).status,
	).toBe("NO_STATUS_TRANSITION");
});

it.each([
	{ origin: "zeroCache", message: "permission denied for schema" },
	{ origin: "zeroCache", message: "unexpected internal error" },
	{ origin: "server", message: "getaddrinfo ENOTFOUND database" },
] as const)("does not retry unrelated internal failure %j", (body) => {
	expect(
		getErrorConnectionTransition(
			new ProtocolError({ kind: "Internal", ...body }),
		).status,
	).toBe("error");
});
