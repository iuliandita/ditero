import { expect, test } from "vitest";
import { signInProviderOptions } from "./sign-in-providers.ts";

test("lists built-ins in a fixed order, then operator providers, only when enabled", () => {
	expect(
		signInProviderOptions({
			socialProviders: ["family", "github", "google", "apple"],
			oidcProviders: [{ id: "family", name: "Family SSO", icon: "shield" }],
		}),
	).toEqual([
		{ id: "google", name: "Google", icon: null },
		{ id: "github", name: "GitHub", icon: null },
		{ id: "apple", name: "Apple", icon: null },
		{ id: "family", name: "Family SSO", icon: "shield" },
	]);
});

test("shows nothing when the server lists nothing or an older server omits the lists", () => {
	expect(signInProviderOptions({})).toEqual([]);
	expect(signInProviderOptions({ socialProviders: [] })).toEqual([]);
});

test("ignores a provider display entry the server did not enable, and unknown icons", () => {
	expect(
		signInProviderOptions({
			socialProviders: ["corp"],
			oidcProviders: [
				{ id: "other", name: "Other", icon: "key" },
				{ id: "corp", name: "Corp", icon: "<script>" },
			],
		}),
	).toEqual([{ id: "corp", name: "Corp", icon: "key" }]);
});
