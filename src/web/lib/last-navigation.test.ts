import { expect, test } from "vitest";
import {
	lastNavigationKey,
	loadLastNavigation,
	saveLastNavigation,
} from "./last-navigation.ts";

function memory() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}

test("navigation is isolated by browser account and native server/account scope", () => {
	const store = memory();
	const scopes = [
		"user-a",
		"user-b",
		'native:["https://first.example","user-a"]',
		'native:["https://second.example","user-a"]',
	];
	for (const [index, scope] of scopes.entries())
		saveLastNavigation(
			scope,
			{ workspaceId: `workspace-${index}`, listId: `list-${index}` },
			store,
		);
	for (const [index, scope] of scopes.entries())
		expect(loadLastNavigation(scope, store)).toEqual({
			workspaceId: `workspace-${index}`,
			listId: `list-${index}`,
		});
	expect(lastNavigationKey("")).toBeNull();
	saveLastNavigation("", { workspaceId: "private", listId: null }, store);
	expect(loadLastNavigation("", store)).toBeNull();
});

test.each([
	"not-json",
	"null",
	"[]",
	"{}",
	'{"workspaceId":"w"}',
	'{"workspaceId":"w","listId":5}',
	'{"workspaceId":"","listId":null}',
])("ignores malformed navigation: %s", (raw) => {
	const store = memory();
	store.setItem("ditero.navigation.user", raw);
	expect(loadLastNavigation("user", store)).toBeNull();
});

test("blocked device storage leaves navigation usable", () => {
	const store = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
	};
	expect(loadLastNavigation("user", store)).toBeNull();
	expect(() =>
		saveLastNavigation("user", { workspaceId: "w", listId: null }, store),
	).not.toThrow();
});
