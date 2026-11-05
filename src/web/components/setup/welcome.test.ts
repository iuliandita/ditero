import { describe, expect, test } from "vitest";
import {
	loadSetupWelcomeDismissed,
	offersSetupWelcome,
	saveSetupWelcomeDismissed,
} from "./welcome.ts";

const eligible = {
	workspaceKind: "personal",
	role: "owner",
	listCount: 0,
	outcome: "pending" as const,
	authoritative: true,
	managed: false,
	dismissed: false,
};

describe("offersSetupWelcome", () => {
	test("offers the starter in an empty own personal space", () => {
		expect(offersSetupWelcome(eligible)).toBe(true);
	});

	test.each([
		["shared workspace", { workspaceKind: "shared" }],
		["non-owner role", { role: "member" }],
		["personal space already has a list", { listCount: 1 }],
		["decided outcome", { outcome: "skipped" as const }],
		["unsynced setup state", { authoritative: false }],
		["managed account", { managed: true }],
		["dismissed once", { dismissed: true }],
	])("stays quiet for %s", (_name, patch) => {
		expect(offersSetupWelcome({ ...eligible, ...patch })).toBe(false);
	});
});

describe("setup welcome dismissal", () => {
	test("persists per account scope", () => {
		const data = new Map<string, string>();
		const store = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		};
		expect(loadSetupWelcomeDismissed("a", store)).toBe(false);
		saveSetupWelcomeDismissed("a", store);
		expect(loadSetupWelcomeDismissed("a", store)).toBe(true);
		expect(loadSetupWelcomeDismissed("b", store)).toBe(false);
	});

	test("survives unavailable storage", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(loadSetupWelcomeDismissed("a", broken)).toBe(false);
		expect(() => saveSetupWelcomeDismissed("a", broken)).not.toThrow();
		expect(loadSetupWelcomeDismissed("", broken)).toBe(false);
	});
});
