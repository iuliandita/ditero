import { describe, expect, test } from "vitest";
import { deriveConnections } from "./connections.ts";

describe("deriveConnections", () => {
	test("shared workspace -> the other user is a connection", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "alice", workspaceId: "w1" },
		];
		expect(deriveConnections(memberships, "me")).toEqual(["alice"]);
	});

	test("no shared workspace -> not a connection", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "alice", workspaceId: "w2" },
		];
		expect(deriveConnections(memberships, "me")).toEqual([]);
	});

	test("self excluded even with multiple memberships", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "me", workspaceId: "w2" },
		];
		expect(deriveConnections(memberships, "me")).toEqual([]);
	});

	test("dedup across multiple shared workspaces", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "me", workspaceId: "w2" },
			{ userId: "alice", workspaceId: "w1" },
			{ userId: "alice", workspaceId: "w2" },
		];
		expect(deriveConnections(memberships, "me")).toEqual(["alice"]);
	});

	test("empty input -> empty result", () => {
		expect(deriveConnections([], "me")).toEqual([]);
	});

	test("a user in a workspace where me is not a member does not leak in", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "bob", workspaceId: "w2" },
		];
		expect(deriveConnections(memberships, "me")).toEqual([]);
	});

	// Deterministic order: lexicographically sorted userId, independent of
	// input order or which shared workspace surfaced the user first.
	test("output is sorted lexicographically by userId", () => {
		const memberships = [
			{ userId: "me", workspaceId: "w1" },
			{ userId: "zoe", workspaceId: "w1" },
			{ userId: "alice", workspaceId: "w1" },
			{ userId: "mallory", workspaceId: "w1" },
		];
		expect(deriveConnections(memberships, "me")).toEqual([
			"alice",
			"mallory",
			"zoe",
		]);
	});
});
