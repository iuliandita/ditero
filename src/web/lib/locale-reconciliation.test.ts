import { describe, expect, it, vi } from "vitest";
import type { Locale } from "./locale.ts";
import {
	createLocaleReconciler,
	reconcileStoredLocale,
} from "./locale-reconciliation.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function dependencies() {
	return {
		currentLocale: () => "en" as Locale,
		isOwnerActive: () => true,
		retireClients: vi.fn(async (_retryFailed: boolean) => {}),
		applyLocale: vi.fn((_locale: Locale) => {}),
		onError: vi.fn((_retry: () => void) => {}),
	};
}

describe("stored locale reconciliation", () => {
	it("does nothing for the current locale or a missing preference", async () => {
		for (const locale of ["en", null] as const) {
			const deps = dependencies();
			await expect(createLocaleReconciler(deps).update(locale)).resolves.toBe(
				false,
			);
			expect(deps.retireClients).not.toHaveBeenCalled();
		}
	});

	it("uses the latest preference while sharing one retirement across hooks", async () => {
		const durable = deferred();
		const deps = dependencies();
		deps.retireClients.mockImplementation(() => durable.promise);
		const owner = {};
		const first = reconcileStoredLocale(owner, "de", deps);
		const next = reconcileStoredLocale(owner, "fr", deps);
		expect(next).toBe(first);
		expect(deps.retireClients).toHaveBeenCalledTimes(1);
		expect(deps.applyLocale).not.toHaveBeenCalled();
		durable.resolve();
		await expect(first).resolves.toBe(true);
		expect(deps.applyLocale).toHaveBeenCalledExactlyOnceWith("fr");
	});

	it("reloads the current locale when the preference changes back during close", async () => {
		const durable = deferred();
		const deps = dependencies();
		deps.retireClients.mockImplementation(() => durable.promise);
		const reconcile = createLocaleReconciler(deps);
		const pending = reconcile.update("de");
		reconcile.update("en");
		durable.resolve();
		await expect(pending).resolves.toBe(true);
		expect(deps.applyLocale).toHaveBeenCalledExactlyOnceWith("en");
	});

	it("does not navigate for an owner unmounted during persistence", async () => {
		const durable = deferred();
		const deps = dependencies();
		let active = true;
		deps.isOwnerActive = () => active;
		deps.retireClients.mockImplementation(() => durable.promise);
		const pending = createLocaleReconciler(deps).update("de");
		active = false;
		durable.resolve();
		await expect(pending).resolves.toBe(false);
		expect(deps.applyLocale).not.toHaveBeenCalled();
	});

	it("reports persistence failure once and retries only on explicit action", async () => {
		const deps = dependencies();
		deps.retireClients.mockRejectedValueOnce(new Error("storage unavailable"));
		const reconcile = createLocaleReconciler(deps);
		await expect(reconcile.update("de")).resolves.toBe(false);
		expect(deps.applyLocale).not.toHaveBeenCalled();
		expect(deps.onError).toHaveBeenCalledTimes(1);
		await reconcile.update("fr");
		expect(deps.retireClients).toHaveBeenCalledTimes(1);
		const retry = deps.onError.mock.calls[0][0];
		retry();
		await vi.waitFor(() => expect(deps.applyLocale).toHaveBeenCalledWith("fr"));
		expect(deps.retireClients.mock.calls).toEqual([[false], [true]]);
	});

	it("an old error action cannot retire a replacement account", async () => {
		const deps = dependencies();
		let active = true;
		deps.isOwnerActive = () => active;
		deps.retireClients.mockRejectedValueOnce(new Error("storage unavailable"));
		await createLocaleReconciler(deps).update("de");
		active = false;
		deps.onError.mock.calls[0][0]();
		expect(deps.retireClients).toHaveBeenCalledTimes(1);
	});
});
