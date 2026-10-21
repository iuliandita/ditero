import { expect, test } from "vitest";
import {
	NATIVE_SETTINGS_SECTIONS,
	settingsSectionFromPath,
} from "./native-settings.ts";

test("only exact Settings paths select a browser section", () => {
	for (const section of NATIVE_SETTINGS_SECTIONS)
		expect(settingsSectionFromPath(`/settings/${section}`)).toBe(section);
	for (const path of [
		"/",
		"/settings",
		"/settings/security/",
		"/settings/../security",
		"/settings/%73ecurity",
		"/settings/security?url=https://other.test",
		"/settings/unknown",
	])
		expect(settingsSectionFromPath(path)).toBeNull();
});
