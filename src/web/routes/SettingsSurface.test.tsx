import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { NativeAccountContext } from "../lib/native-account.tsx";
import { SettingsSurface } from "./SettingsSurface.tsx";

const { control, browserOnly } = vi.hoisted(() => {
	const control = { native: false };
	return {
		control,
		browserOnly: (name: string) => () => {
			if (control.native) throw new Error(`Native settings mounted ${name}`);
			return name;
		},
	};
});
// New messages are compiled by the serialized app build, not this render check.
vi.mock("../../paraglide/messages.js", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("../components/settings/NotificationSettings.tsx", () => ({
	NotificationSettings: browserOnly("browser-notifications"),
}));
vi.mock("./SecurityPanel.tsx", () => ({
	SecurityPanel: browserOnly("browser-security"),
}));
vi.mock("../components/settings/DataPortabilityPanel.tsx", () => ({
	DataPortabilityPanel: browserOnly("browser-export"),
}));
vi.mock("../components/settings/ImportPlanPanel.tsx", () => ({
	ImportPlanPanel: browserOnly("browser-import"),
}));
vi.mock("../components/settings/AccountDeletionPanel.tsx", () => ({
	AccountDeletionPanel: browserOnly("browser-deletion"),
}));
vi.mock("../components/e2e/EncryptedFilesPanel.tsx", () => ({
	EncryptedFilesPanel: ({ userId }: { userId: string }) =>
		`native-encryption:${userId}`,
}));
vi.mock("../components/settings/AccountPanel.tsx", () => ({
	AccountPanel: () => "shared-account",
}));
vi.mock("../components/settings/DisplaySettings.tsx", () => ({
	DisplaySettings: () => "shared-display",
}));
vi.mock("../components/settings/FocusSettings.tsx", () => ({
	FocusSettings: () => "shared-focus",
}));
vi.mock("../components/settings/KarmaSettings.tsx", () => ({
	KarmaSettings: () => "shared-karma-settings",
}));
vi.mock("../components/karma/KarmaPanel.tsx", () => ({
	KarmaPanel: () => "shared-karma",
}));
vi.mock("../components/settings/KeymapSettings.tsx", () => ({
	KeymapSettings: () => "shared-keyboard",
}));
vi.mock("../components/settings/LabelManager.tsx", () => ({
	LabelManager: () => "shared-labels",
}));
vi.mock("../components/settings/TemplateManager.tsx", () => ({
	TemplateManager: () => "shared-templates",
}));
vi.mock("../components/settings/LanguageSwitcher.tsx", () => ({
	LanguageSwitcher: () => "shared-language",
}));
vi.mock("../components/settings/ThemeSwitcher.tsx", () => ({
	ThemeSwitcher: () => "shared-theme",
}));
vi.mock("../components/settings/TimeZoneSetting.tsx", () => ({
	TimeZoneSetting: () => "shared-timezone",
}));
vi.mock("../components/shell/SyncIndicator.tsx", () => ({
	SyncIndicator: () => "shared-sync",
}));

const surface = (
	<SettingsSurface
		activeId="workspace-1"
		activeRole="owner"
		isDesktop={false}
		persistLocale={async () => true}
		onBack={() => {}}
		onOpenList={() => {}}
		initialSection="appearance"
	/>
);

test("native settings never mount browser account panels, retain native encryption and shared settings, and leave browser panels intact", () => {
	control.native = true;
	const native = renderToStaticMarkup(
		<NativeAccountContext
			value={{
				profile: {
					id: "canonical-user",
					name: "Native user",
					email: "user@example.test",
				},
				origin: "https://chosen.example.test",
				storageScope: "native-scope",
				changeServer: async () => {},
			}}
		>
			{surface}
		</NativeAccountContext>,
	);
	expect(native.match(/data-testid="native-browser-settings"/g)).toHaveLength(
		4,
	);
	expect(native.match(/href="https:\/\/chosen.example.test\/"/g)).toHaveLength(
		4,
	);
	expect(native).toContain("min-h-11");
	expect(native).toContain("native-encryption:canonical-user");
	for (const marker of [
		"shared-account",
		"shared-display",
		"shared-theme",
		"shared-language",
		"shared-timezone",
		"shared-labels",
		"shared-templates",
		"shared-focus",
		"shared-karma",
	])
		expect(native).toContain(marker);
	control.native = false;
	const browser = renderToStaticMarkup(surface);
	for (const marker of [
		"browser-notifications",
		"browser-security",
		"browser-export",
		"browser-import",
		"browser-deletion",
	])
		expect(browser).toContain(marker);
	expect(browser).not.toContain('data-testid="native-browser-settings"');
});

test.each([
	"unifiedpush",
	"desktop",
] as const)("%s notification controls use the platform copy in native settings", (provider) => {
	control.native = true;
	const state = async () => ({
		state: "disabled" as const,
		permission: "granted" as const,
		provider,
	});
	const phone = renderToStaticMarkup(
		<NativeAccountContext
			value={{
				profile: { id: "maya", name: "Maya Chen", email: "maya@example.test" },
				origin: "https://chosen.example.test",
				storageScope: "native-maya",
				changeServer: async () => {},
				push: {
					identity: "native-maya:session",
					provider,
					read: state,
					enable: state,
					disable: state,
					permission: state,
				},
			}}
		>
			{surface}
		</NativeAccountContext>,
	);
	expect(phone).toContain('aria-labelledby="native-push-heading"');
	const prefix = provider === "desktop" ? "desktop_push" : "native_push";
	const other = provider === "desktop" ? "native_push" : "desktop_push";
	expect(phone).toContain(`${prefix}_heading`);
	expect(phone).toContain(`${prefix}_help`);
	expect(phone).toContain(`${prefix}_loading`);
	expect(phone).not.toContain(`${other}_heading`);
	expect(phone).toContain('data-testid="native-browser-settings"');
	expect(phone).not.toContain("browser-notifications");
	control.native = false;
	expect(renderToStaticMarkup(surface)).not.toContain(
		'id="native-push-heading"',
	);
});
