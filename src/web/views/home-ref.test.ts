import { describe, expect, test } from "vitest";
import { dashboardHomeRef, resolveHomeRef } from "./home-ref.ts";

const known = { savedViewIds: ["v1"], dashboardIds: ["d1"] };

describe("resolveHomeRef", () => {
	test("null/undefined -> default home", () => {
		expect(resolveHomeRef(null, known)).toEqual({ kind: "view", id: "today" });
		expect(resolveHomeRef(undefined, known)).toEqual({
			kind: "view",
			id: "today",
		});
	});

	test("builtin id -> view", () => {
		expect(resolveHomeRef("assigned-to-me", known)).toEqual({
			kind: "view",
			id: "assigned-to-me",
		});
	});

	test("saved view id -> view", () => {
		expect(resolveHomeRef("v1", known)).toEqual({ kind: "view", id: "v1" });
	});

	test("dashboard:<id> hit -> dashboard", () => {
		expect(resolveHomeRef(dashboardHomeRef("d1"), known)).toEqual({
			kind: "dashboard",
			id: "d1",
		});
	});

	test("dashboard:<id> dangling -> today", () => {
		expect(resolveHomeRef(dashboardHomeRef("gone"), known)).toEqual({
			kind: "view",
			id: "today",
		});
	});

	test("garbage -> today", () => {
		expect(resolveHomeRef("not-a-ref", known)).toEqual({
			kind: "view",
			id: "today",
		});
	});
});
