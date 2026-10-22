import { beforeEach, describe, expect, test } from "vitest";
import {
	readVoiceConsent,
	resetVoiceConsentSession,
	voiceConsentKey,
	writeVoiceConsent,
} from "./voice-consent.ts";

const memory = () => {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
};

beforeEach(resetVoiceConsentSession);

describe("voice vendor notice consent", () => {
	test("is per user and persists in device storage", () => {
		const storage = memory();
		expect(readVoiceConsent("a", storage)).toBe(false);
		writeVoiceConsent("a", storage);
		resetVoiceConsentSession();
		expect(storage.data.get(voiceConsentKey("a"))).toBe("1");
		expect(readVoiceConsent("a", storage)).toBe(true);
		expect(readVoiceConsent("b", storage)).toBe(false);
	});

	test("only the exact stored value counts", () => {
		const storage = memory();
		for (const value of ["", "0", "true", "11"]) {
			storage.data.set(voiceConsentKey("a"), value);
			expect(readVoiceConsent("a", storage)).toBe(false);
		}
	});

	test("falls back to the page session when storage is unusable", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		writeVoiceConsent("a", broken);
		expect(readVoiceConsent("a", broken)).toBe(true);
		expect(readVoiceConsent("b", broken)).toBe(false);
		expect(readVoiceConsent("a", null)).toBe(true);
	});

	test("no user means no acceptance is stored or granted", () => {
		const storage = memory();
		writeVoiceConsent("", storage);
		expect(storage.data.size).toBe(0);
		expect(readVoiceConsent("", storage)).toBe(false);
	});
});
