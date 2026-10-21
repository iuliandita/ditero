import { afterEach, expect, test, vi } from "vitest";
import { captureFastInvite, tokenFromLocation } from "./AcceptInvite.tsx";

afterEach(() => vi.unstubAllGlobals());

function location(href: string) {
	const browser = { location: new URL(href) };
	const values = new Map<string, string>();
	vi.stubGlobal("window", browser);
	vi.stubGlobal("history", {
		state: { preserved: true },
		replaceState: vi.fn((_state, _title, url: string) => {
			browser.location = new URL(url, browser.location);
		}),
	});
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	return { browser, values };
}

test.each([
	"https://todo.example/accept?token=bearer&e2e=sealed#e2e=secret",
	"https://todo.example/accept?e2e=sealed#token=bearer&e2e=secret",
])("captures encrypted invite %s without losing the token across reload", (href) => {
	const { browser, values } = location(href);
	const grant = {
		requestId: "request",
		recipientPublicKey: "recipient",
		enc: "enc",
		ciphertext: "wrap",
	};
	values.set(
		"ditero:e2e-invite:bearer",
		JSON.stringify({ payload: "sealed", fragment: "secret", grant }),
	);
	expect(tokenFromLocation()).toBe("bearer");
	const captured = captureFastInvite(tokenFromLocation());
	expect(captured).toEqual({ payload: "sealed", fragment: "secret", grant });
	expect(browser.location.searchParams.has("token")).toBe(false);
	expect(browser.location.searchParams.get("e2e")).toBe("sealed");
	expect(
		new URLSearchParams(browser.location.hash.slice(1)).get("e2e"),
	).toBeNull();
	expect(tokenFromLocation()).toBe("bearer");
	// Strict Mode remounts and the interrupted-finalize reload use the same cache.
	expect(captureFastInvite(tokenFromLocation())).toEqual(captured);
	expect(history.replaceState).toHaveBeenCalledWith(
		{ preserved: true },
		"",
		"/accept?e2e=sealed#token=bearer",
	);
});

test("legacy ordinary invite moves its encoded token out of the query", () => {
	const token = "bearer/+=&?";
	const { browser } = location(
		`https://todo.example/accept?token=${encodeURIComponent(token)}`,
	);
	expect(captureFastInvite(tokenFromLocation())).toBeNull();
	expect(browser.location.search).toBe("");
	expect(tokenFromLocation()).toBe(token);
});

test("unavailable tab storage retains the live encrypted invite and strips its key", () => {
	const { browser } = location(
		"https://todo.example/accept?token=bearer&e2e=sealed#e2e=secret",
	);
	vi.stubGlobal("sessionStorage", {
		getItem: () => {
			throw new Error("denied");
		},
		setItem: () => {
			throw new Error("denied");
		},
	});
	expect(captureFastInvite(tokenFromLocation())).toEqual({
		payload: "sealed",
		fragment: "secret",
	});
	expect(browser.location.hash).toBe("#token=bearer");
	expect(browser.location.searchParams.has("token")).toBe(false);
});
