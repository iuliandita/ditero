import { afterEach, describe, expect, test, vi } from "vitest";
import {
	applyDisplayPreferences,
	DEFAULT_DISPLAY_PREFERENCES,
	displayPreferencesKey,
	parseDisplayPreferences,
	readDisplayPreferences,
	writeDisplayPreferences,
} from "./display-preferences.ts";

function memory() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("display preferences", () => {
	test("accepts every preset and an independent contrast choice", () => {
		for (const readingSize of ["standard", "comfortable", "large"] as const) {
			for (const highContrast of [false, true]) {
				const preferences = { readingSize, highContrast };
				expect(parseDisplayPreferences(JSON.stringify(preferences))).toEqual(
					preferences,
				);
			}
		}
	});

	test("invalid or missing settings use safe defaults", () => {
		for (const raw of [
			null,
			"not json",
			"null",
			"[]",
			"true",
			"{}",
			'{"readingSize":"huge","highContrast":true}',
			'{"readingSize":"large","highContrast":"true"}',
			'{"readingSize":"large"}',
		]) {
			expect(parseDisplayPreferences(raw)).toEqual(DEFAULT_DISPLAY_PREFERENCES);
		}
	});

	test("persists each account separately and never creates an anonymous bucket", () => {
		const storage = memory();
		const first = { readingSize: "large", highContrast: true } as const;
		const second = { readingSize: "comfortable", highContrast: false } as const;
		expect(writeDisplayPreferences("first", first, storage)).toBe(true);
		expect(readDisplayPreferences("first", storage)).toEqual(first);
		expect(readDisplayPreferences("second", storage)).toEqual(
			DEFAULT_DISPLAY_PREFERENCES,
		);
		expect(writeDisplayPreferences("second", second, storage)).toBe(true);
		expect(readDisplayPreferences("first", storage)).toEqual(first);
		expect(readDisplayPreferences("second", storage)).toEqual(second);
		for (const userId of [null, undefined, ""]) {
			expect(displayPreferencesKey(userId)).toBeNull();
			expect(writeDisplayPreferences(userId, first, storage)).toBe(false);
			expect(readDisplayPreferences(userId, storage)).toEqual(
				DEFAULT_DISPLAY_PREFERENCES,
			);
		}
		expect(storage.data.size).toBe(2);
	});

	test("blocked reads and writes do not throw or claim persistence", () => {
		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota exceeded");
			},
		};
		expect(readDisplayPreferences("first", blocked)).toEqual(
			DEFAULT_DISPLAY_PREFERENCES,
		);
		expect(
			writeDisplayPreferences("first", DEFAULT_DISPLAY_PREFERENCES, blocked),
		).toBe(false);
		expect(readDisplayPreferences("first", null)).toEqual(
			DEFAULT_DISPLAY_PREFERENCES,
		);
		expect(
			writeDisplayPreferences("first", DEFAULT_DISPLAY_PREFERENCES, null),
		).toBe(false);
	});

	test("a blocked localStorage accessor falls back safely", () => {
		vi.stubGlobal("localStorage", undefined);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get: () => {
				throw new Error("SecurityError");
			},
		});
		expect(readDisplayPreferences("first")).toEqual(
			DEFAULT_DISPLAY_PREFERENCES,
		);
		expect(writeDisplayPreferences("first", DEFAULT_DISPLAY_PREFERENCES)).toBe(
			false,
		);
	});

	test("replaces both document attributes on account switch and sign-out", () => {
		const root = {
			dataset: { readingSize: "standard", highContrast: "false" },
		};
		const storage = memory();
		writeDisplayPreferences(
			"first",
			{ readingSize: "large", highContrast: true },
			storage,
		);
		applyDisplayPreferences(readDisplayPreferences("first", storage), root);
		expect(root.dataset).toEqual({
			readingSize: "large",
			highContrast: "true",
		});
		applyDisplayPreferences(readDisplayPreferences("second", storage), root);
		expect(root.dataset).toEqual({
			readingSize: "standard",
			highContrast: "false",
		});
		applyDisplayPreferences(readDisplayPreferences("first", storage), root);
		applyDisplayPreferences(readDisplayPreferences(null, storage), root);
		expect(root.dataset).toEqual({
			readingSize: "standard",
			highContrast: "false",
		});
	});
});
