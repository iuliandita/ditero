export const NATIVE_SETTINGS_SECTIONS = [
	"notifications",
	"security",
	"access-tokens",
	"calendar-feeds",
	"data",
	"danger",
] as const;
export type NativeSettingsSection = (typeof NATIVE_SETTINGS_SECTIONS)[number];

/** Exact browser destinations shared by the native settings controls and web entry. */
export function settingsSectionFromPath(
	path: string,
): NativeSettingsSection | null {
	return (
		NATIVE_SETTINGS_SECTIONS.find(
			(section) => path === `/settings/${section}`,
		) ?? null
	);
}
