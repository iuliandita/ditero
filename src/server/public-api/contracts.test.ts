import { describe, expect, test } from "vitest";
import {
	PublicApiError,
	publicApiProblem,
	tokenCreateSchema,
} from "../../domain/public-api.ts";
import { bearerToken, encodePageCursor, parsePageQuery } from "./contracts.ts";
import { publicApiOpenApi } from "./openapi.ts";

const url = (query = "") => new URL(`http://localhost/api/v1/tasks${query}`);

test("OpenAPI derives all implemented collection DTOs from shared schemas", () => {
	const document = publicApiOpenApi();
	expect(document.openapi).toBe("3.1.0");
	expect(Object.keys(document.paths)).toHaveLength(15);
	expect(document.paths).toHaveProperty("/api/v1/dashboards/{id}");
	expect(document.paths).toHaveProperty("/api/v1/tasks");
	expect(JSON.stringify(document)).not.toContain("token_hash");
});

describe("public API cursor contract", () => {
	test("binds cursors to the collection and filters, while allowing page-size changes", () => {
		const query = parsePageQuery(url("?listId=list-1&done=false"), "tasks");
		const cursor = encodePageCursor("tasks", query, "task-2");
		expect(
			parsePageQuery(
				url(`?listId=list-1&done=false&limit=1&cursor=${cursor}`),
				"tasks",
			).after,
		).toBe("task-2");
		expect(() =>
			parsePageQuery(
				url(`?listId=list-2&done=false&cursor=${cursor}`),
				"tasks",
			),
		).toThrow(PublicApiError);
		expect(() => parsePageQuery(url(`?cursor=${cursor}`), "lists")).toThrow(
			PublicApiError,
		);
	});
	test.each([
		"?limit=0",
		"?limit=101",
		"?limit=-1",
		"?limit=01",
		"?limit=1&limit=2",
		"?done=yes",
		"?listId=",
		"?offset=0",
		"?cursor=garbage",
		"?cursor=e30",
		"?workspaceId=a&workspaceId=b",
	])("rejects malformed or ambiguous input %s", (query) => {
		expect(() => parsePageQuery(url(query), "tasks")).toThrow(PublicApiError);
	});
});

test("bearer authentication never falls back to cookies or partial tokens", () => {
	const token = `ditero_pat_${"a".repeat(43)}`;
	expect(bearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(
		token,
	);
	for (const value of [
		token,
		`Bearer ${token} extra`,
		`Basic ${token}`,
		`Bearer ${token.slice(0, -1)}`,
	]) {
		expect(bearerToken(new Headers({ authorization: value }))).toBeNull();
	}
	expect(bearerToken(new Headers({ cookie: "session=anything" }))).toBeNull();
});

test("token defaults are read-only and expiring; privilege and lifetime inputs are exact", () => {
	expect(tokenCreateSchema.parse({ name: " Agent " })).toEqual({
		name: "Agent",
		access: "read",
		expiresInDays: 90,
	});
	for (const body of [
		{ name: "" },
		{ name: "bad\nname" },
		{ name: "agent", access: "admin" },
		{ name: "agent", expiresInDays: 366 },
		{ name: "agent", expiresInDays: 0 },
		{ name: "agent", userId: "other" },
	]) {
		expect(tokenCreateSchema.safeParse(body).success).toBe(false);
	}
});

test("unauthorized errors challenge bearer auth without disclosing token state", async () => {
	const response = publicApiProblem(
		new PublicApiError(
			401,
			"unauthorized",
			"A valid personal access token is required",
		),
	);
	expect(response.status).toBe(401);
	expect(response.headers.get("www-authenticate")).toBe(
		'Bearer realm="ditero"',
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("content-type")).toBe("application/problem+json");
	expect(await response.json()).toMatchObject({
		status: 401,
		code: "unauthorized",
	});
});
