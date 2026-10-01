import { describe, expect, it, vi } from "vitest";
import {
	changeLocale,
	createLocaleChangeAction,
	localeOptions,
} from "./language-switcher.ts";
import { LOCALES, nativeName } from "./locale.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function actionDependencies() {
	return {
		setLocale: vi.fn(),
		applyDocumentLocale: vi.fn(),
		persistLocale: vi.fn(async () => true),
		retireClients: vi.fn(async () => {}),
		isOwnerActive: () => true,
		isChildMounted: () => true,
		onPending: vi.fn(),
		onApplied: vi.fn(),
		onInlineError: vi.fn(),
		onGlobalError: vi.fn((_retry: () => void) => {}),
	};
}

describe("localeOptions", () => {
	it("lists all six locales with native names", () => {
		expect(localeOptions()).toEqual(
			LOCALES.map((value) => ({ value, label: nativeName(value) })),
		);
	});
});

describe("locale change action", () => {
	it("continues account navigation after the settings child unmounts", async () => {
		const durable = deferred();
		const deps = actionDependencies();
		let mounted = true;
		deps.isChildMounted = () => mounted;
		deps.retireClients.mockImplementation(() => durable.promise);
		const action = createLocaleChangeAction("de", deps);
		const change = action.run();
		await vi.waitFor(() => expect(deps.retireClients).toHaveBeenCalledTimes(1));
		mounted = false;
		durable.resolve();
		await change;
		expect(deps.setLocale).toHaveBeenCalledExactlyOnceWith("de");
		expect(deps.onApplied).not.toHaveBeenCalled();
		expect(deps.onPending.mock.calls).toEqual([[true]]);
	});

	it("reports failure globally after child unmount and retries the saved preference", async () => {
		const durable = deferred();
		const deps = actionDependencies();
		let mounted = true;
		deps.isChildMounted = () => mounted;
		deps.retireClients.mockImplementationOnce(() => durable.promise);
		const change = createLocaleChangeAction("de", deps).run();
		await vi.waitFor(() => expect(deps.retireClients).toHaveBeenCalledTimes(1));
		mounted = false;
		durable.reject(new Error("storage unavailable"));
		await change;
		expect(deps.onGlobalError).toHaveBeenCalledTimes(1);
		expect(deps.onInlineError).not.toHaveBeenCalled();
		expect(deps.setLocale).not.toHaveBeenCalled();
		deps.onGlobalError.mock.calls[0][0]();
		await vi.waitFor(() => expect(deps.setLocale).toHaveBeenCalledWith("de"));
		expect(deps.retireClients).toHaveBeenCalledTimes(2);
		expect(deps.persistLocale).toHaveBeenCalledTimes(1);
		expect(deps.onApplied).not.toHaveBeenCalled();
	});

	it("suppresses old-owner navigation, errors, and later retry after account replacement", async () => {
		const durable = deferred();
		const deps = actionDependencies();
		let active = true;
		deps.isOwnerActive = () => active;
		deps.retireClients.mockImplementationOnce(() => durable.promise);
		const action = createLocaleChangeAction("de", deps);
		const change = action.run();
		await vi.waitFor(() => expect(deps.retireClients).toHaveBeenCalledTimes(1));
		active = false;
		durable.reject(new Error("storage unavailable"));
		await change;
		await action.run();
		expect(deps.retireClients).toHaveBeenCalledTimes(1);
		expect(deps.setLocale).not.toHaveBeenCalled();
		expect(deps.onInlineError).not.toHaveBeenCalled();
		expect(deps.onGlobalError).not.toHaveBeenCalled();
	});
});

describe("changeLocale", () => {
	it("waits for the local preference and durable retirement before applying locale", async () => {
		const local = deferred();
		const durable = deferred();
		const calls: string[] = [];
		const setLocale = vi.fn(() => calls.push("setLocale"));
		const applyDocumentLocale = vi.fn(() => calls.push("applyDocumentLocale"));
		const persistLocale = vi.fn(async () => {
			calls.push("persistLocale");
			await local.promise;
			return true;
		});
		const retireClients = vi.fn(() => {
			calls.push("retireClients");
			return durable.promise;
		});
		const change = changeLocale("de", {
			setLocale,
			applyDocumentLocale,
			persistLocale,
			retireClients,
		});
		expect(calls).toEqual(["persistLocale"]);
		local.resolve();
		await vi.waitFor(() => expect(retireClients).toHaveBeenCalledTimes(1));
		expect(setLocale).not.toHaveBeenCalled();
		expect(applyDocumentLocale).not.toHaveBeenCalled();
		durable.resolve();
		await expect(change).resolves.toBe(true);
		expect(calls).toEqual([
			"persistLocale",
			"retireClients",
			"applyDocumentLocale",
			"setLocale",
		]);
		expect(setLocale).toHaveBeenCalledWith("de");
	});

	it("works pre-auth without a locale persistence callback", async () => {
		const setLocale = vi.fn();
		const applyDocumentLocale = vi.fn();
		await changeLocale("ar", { setLocale, applyDocumentLocale });
		expect(applyDocumentLocale).toHaveBeenCalledWith("ar");
		expect(setLocale).toHaveBeenCalledWith("ar");
	});

	it("refuses a locale change whose local preference write failed", async () => {
		const setLocale = vi.fn();
		const retireClients = vi.fn(async () => {});
		await expect(
			changeLocale("de", {
				setLocale,
				applyDocumentLocale: vi.fn(),
				persistLocale: async () => false,
				retireClients,
			}),
		).rejects.toThrow("not saved locally");
		expect(retireClients).not.toHaveBeenCalled();
		expect(setLocale).not.toHaveBeenCalled();
	});

	it("does not apply the locale after a persistence failure", async () => {
		const setLocale = vi.fn();
		const applyDocumentLocale = vi.fn();
		await expect(
			changeLocale("de", {
				setLocale,
				applyDocumentLocale,
				retireClients: async () => {
					throw new Error("storage unavailable");
				},
			}),
		).rejects.toThrow("storage unavailable");
		expect(applyDocumentLocale).not.toHaveBeenCalled();
		expect(setLocale).not.toHaveBeenCalled();
	});

	it("cancels old-owner navigation after the durability barrier", async () => {
		const setLocale = vi.fn();
		const applyDocumentLocale = vi.fn();
		await expect(
			changeLocale("de", {
				setLocale,
				applyDocumentLocale,
				retireClients: async () => {},
				shouldApply: () => false,
			}),
		).resolves.toBe(false);
		expect(applyDocumentLocale).not.toHaveBeenCalled();
		expect(setLocale).not.toHaveBeenCalled();
	});
});
