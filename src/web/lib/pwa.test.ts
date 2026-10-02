import { describe, expect, it, vi } from "vitest";
import { isPublicNavigation, navigationResponse } from "../service-worker.ts";
import { activatePwaUpdate, canRegisterPwa } from "./pwa.ts";

describe("public PWA shell", () => {
	it("never substitutes cached HTML for API, consent, queries, or HTTP failures", async () => {
		const shell = vi.fn(async () => new Response("static shell"));
		for (const path of [
			"/api/auth/get-session",
			"/api/zero/query",
			"/native/authorize",
			"/accept",
			"/?token=private",
		]) {
			const request = new Request(`https://example.com${path}`);
			expect(isPublicNavigation(new URL(request.url))).toBe(false);
			await expect(
				navigationResponse(
					request,
					async () => {
						throw new Error("offline");
					},
					shell,
				),
			).rejects.toThrow("offline");
		}
		const response = new Response("unauthorized", { status: 401 });
		expect(
			await navigationResponse(
				new Request("https://example.com/"),
				async () => response,
				shell,
			),
		).toBe(response);
		expect(shell).not.toHaveBeenCalled();
		expect(
			await (
				await navigationResponse(
					new Request("https://example.com/"),
					async () => {
						throw new Error("offline");
					},
					shell,
				)
			).text(),
		).toBe("static shell");
	});
	it("allows production self-hosted browser origins while refusing native and development registration", () => {
		for (const hostname of [
			"localhost",
			"127.0.0.1",
			"[::1]",
			"example.com",
			"192.0.2.1",
		]) {
			expect(
				canRegisterPwa({ protocol: "https:", hostname }, false, true),
			).toBe(true);
			expect(canRegisterPwa({ protocol: "https:", hostname }, true, true)).toBe(
				false,
			);
		}
		for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
			expect(canRegisterPwa({ protocol: "http:", hostname }, false, true)).toBe(
				true,
			);
			expect(canRegisterPwa({ protocol: "http:", hostname }, true, true)).toBe(
				false,
			);
			for (const protocol of ["http:", "https:"])
				expect(canRegisterPwa({ protocol, hostname }, false, false)).toBe(
					false,
				);
		}
		for (const hostname of [
			"example.com",
			"192.0.2.1",
			"app.localhost",
			"tauri.localhost",
		])
			expect(canRegisterPwa({ protocol: "http:", hostname }, false, true)).toBe(
				false,
			);
		expect(
			canRegisterPwa(
				{ protocol: "tauri:", hostname: "localhost" },
				false,
				true,
			),
		).toBe(false);
	});
	it("waits for durable retirement and does not activate after storage failure", async () => {
		const postMessage = vi.fn();
		const events = Object.assign(new EventTarget(), {
			controller: null as ServiceWorker | null,
		});
		const reload = vi.fn();
		await expect(
			activatePwaUpdate(
				{ postMessage, state: "installed" },
				async () => {
					throw new Error("disk full");
				},
				events,
				reload,
			),
		).rejects.toThrow("disk full");
		expect(postMessage).not.toHaveBeenCalled();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const update = activatePwaUpdate(
			{ postMessage, state: "installed" },
			() => pending,
			events,
			reload,
		);
		expect(postMessage).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
		expect(reload).not.toHaveBeenCalled();
		events.dispatchEvent(new Event("controllerchange"));
		await update;
		expect(reload).toHaveBeenCalledOnce();
	});
	it("remembers concurrent activation but reloads only after deferred retirement", async () => {
		const events = Object.assign(new EventTarget(), {
			controller: null as ServiceWorker | null,
		});
		const removed = vi.spyOn(events, "removeEventListener");
		const postMessage = vi.fn();
		const reload = vi.fn();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const update = activatePwaUpdate(
			{ postMessage, state: "installed" },
			() => pending,
			events,
			reload,
		);
		events.dispatchEvent(new Event("controllerchange"));
		expect(reload).not.toHaveBeenCalled();
		finish();
		await update;
		expect(reload).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
		expect(removed).toHaveBeenCalledWith(
			"controllerchange",
			expect.any(Function),
		);
	});
	it("reloads an already-active notice after retirement without waiting for another activation", async () => {
		const events = Object.assign(new EventTarget(), {
			controller: null as ServiceWorker | null,
		});
		const postMessage = vi.fn();
		const reload = vi.fn();
		const retire = vi.fn(async () => {
			expect(reload).not.toHaveBeenCalled();
		});
		await activatePwaUpdate(
			{ postMessage, state: "activated" },
			retire,
			events,
			reload,
		);
		expect(retire).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
	});
	it("removes activation observers and refuses reload when concurrent retirement fails", async () => {
		const events = Object.assign(new EventTarget(), {
			controller: null as ServiceWorker | null,
		});
		const removed = vi.spyOn(events, "removeEventListener");
		const postMessage = vi.fn();
		const reload = vi.fn();
		await expect(
			activatePwaUpdate(
				{ postMessage, state: "activated" },
				async () => {
					events.dispatchEvent(new Event("controllerchange"));
					throw new Error("disk full");
				},
				events,
				reload,
			),
		).rejects.toThrow("disk full");
		expect(reload).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(removed).toHaveBeenCalledWith(
			"controllerchange",
			expect.any(Function),
		);
	});
});
