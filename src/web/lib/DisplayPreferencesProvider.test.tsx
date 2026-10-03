import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../domain/appearance.ts";
import type { AppearanceSync } from "../hooks/useAppearanceSync.ts";
import {
	DisplayPreferencesProvider,
	useDisplayPreferences,
} from "./DisplayPreferencesProvider.tsx";

function Probe() {
	const value = useDisplayPreferences();
	return (
		<output>
			{JSON.stringify({
				library: value.themeLibrary,
				accent: value.preferences.accentTheme,
				reading: value.preferences.readingSize,
				loading: value.appearanceLoading,
			})}
		</output>
	);
}
const values = new Map<string, string>();
function render(sync: AppearanceSync, userId = "alice") {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn(),
	});
	return renderToStaticMarkup(
		<DisplayPreferencesProvider userId={userId} sync={sync}>
			<Probe />
		</DisplayPreferencesProvider>,
	);
}
function transport(
	loading: boolean,
	appearance: AppearanceSync["appearance"],
): AppearanceSync {
	return { loading, appearance, isActive: () => true, mutate: vi.fn() };
}
afterEach(() => {
	values.clear();
	vi.unstubAllGlobals();
});
test("legacy cache is only a loading hint and never uploads itself", () => {
	values.set(
		"ditero.themes.alice",
		JSON.stringify({ selected: "paper", useAccent: false, documents: [] }),
	);
	const loading = transport(true, null);
	expect(render(loading)).toContain("paper");
	expect(loading.mutate).not.toHaveBeenCalled();
	const ready = transport(false, null);
	expect(render(ready)).toContain("default");
	expect(render(ready)).not.toContain("paper");
	expect(ready.mutate).not.toHaveBeenCalled();
});
test("server palette wins over stale device cache while reading size remains device local", () => {
	values.set(
		"ditero.themes.alice",
		JSON.stringify({ selected: "paper", useAccent: false, documents: [] }),
	);
	values.set(
		"ditero.display.alice",
		JSON.stringify({
			readingSize: "large",
			highContrast: true,
			accentTheme: "violet",
		}),
	);
	const html = render(
		transport(false, {
			...DEFAULT_APPEARANCE,
			selected: "slate",
			accentTheme: "blue",
		}),
	);
	expect(html).toContain("slate");
	expect(html).toContain("blue");
	expect(html).toContain("large");
	expect(html).not.toContain("paper");
	expect(html).not.toContain("violet");
	expect(render(transport(true, null), "bob")).not.toContain("paper");
});
