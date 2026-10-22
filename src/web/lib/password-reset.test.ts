import { describe, expect, test, vi } from "vitest";
import { getLocale, overwriteGetLocale } from "../../paraglide/runtime.js";
import {
	newPasswordProblem,
	readResetLink,
	requestPasswordReset,
	submitPasswordReset,
} from "./password-reset.ts";

// Expected values are catalog literals so an emptied entry cannot pass.

function reply(status: number, body: unknown) {
	return vi.fn(async () => Response.json(body, { status }));
}

describe("readResetLink", () => {
	test.each([
		["?token=abc", { kind: "token", token: "abc" }],
		["?error=INVALID_TOKEN", { kind: "invalid" }],
		["?token=abc&error=INVALID_TOKEN", { kind: "invalid" }],
		["", { kind: "none" }],
		["?token=", { kind: "none" }],
	])("%s", (search, expected) => {
		expect(readResetLink(search)).toEqual(expected);
	});
});

test("newPasswordProblem enforces the shared length rules and the repeat", () => {
	expect(newPasswordProblem("short", "short")).toBe(
		"That password is too short.",
	);
	expect(newPasswordProblem("x".repeat(129), "x".repeat(129))).toBe(
		"That password is too long.",
	);
	expect(newPasswordProblem("long-enough-1", "long-enough-2")).toBe(
		"The passwords don't match.",
	);
	expect(newPasswordProblem("long-enough-1", "long-enough-1")).toBeNull();
});

describe("requestPasswordReset", () => {
	test("asks for the web reset page as the link target", async () => {
		const request = reply(200, { status: true });
		expect(await requestPasswordReset("ada@example.test", request)).toEqual({
			kind: "sent",
		});
		expect(request).toHaveBeenCalledWith(
			"/api/auth/request-password-reset",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					email: "ada@example.test",
					redirectTo: "/reset-password",
				}),
			}),
		);
	});

	test("explains a server that cannot send mail", async () => {
		expect(
			await requestPasswordReset(
				"ada@example.test",
				reply(503, { code: "MAIL_NOT_CONFIGURED", message: "en only" }),
			),
		).toEqual({
			kind: "error",
			message:
				"This server cannot send email, so password resets by email are unavailable. Ask your administrator to reset your password or to configure SMTP.",
		});
	});

	test("falls back when the reply carries no reason", async () => {
		expect(
			await requestPasswordReset(
				"ada@example.test",
				vi.fn(async () => new Response("bad gateway", { status: 502 })),
			),
		).toEqual({
			kind: "error",
			message: "The reset link could not be requested. Try again.",
		});
	});
});

describe("submitPasswordReset", () => {
	test("lists only the credential kinds the server actually removed", async () => {
		expect(
			await submitPasswordReset(
				"token",
				"new-password-456",
				reply(200, {
					status: true,
					revoked: {
						accessTokens: 2,
						calendarFeeds: 0,
						passkeys: 1,
						linkedAccounts: 0,
						constructor: 3,
					},
				}),
			),
		).toEqual({ kind: "done", revoked: ["accessTokens", "passkeys"] });
	});

	test("turns a spent or expired token into the invalid-link state", async () => {
		expect(
			await submitPasswordReset(
				"token",
				"new-password-456",
				reply(400, { code: "INVALID_TOKEN", message: "Invalid token" }),
			),
		).toEqual({ kind: "invalid" });
	});

	test("localizes a password the server rejects", async () => {
		expect(
			await submitPasswordReset(
				"token",
				"x",
				reply(400, {
					code: "PASSWORD_TOO_SHORT",
					message: "Password too short",
				}),
			),
		).toEqual({ kind: "error", message: "That password is too short." });
	});
});

test.each([
	"request",
	"submit",
])("localizes a code-less HTTP 429 on reset %s", async (action) => {
	const originalGetLocale = getLocale;
	overwriteGetLocale(() => "de");
	try {
		const request = reply(429, {
			message: "Too many requests. Please try again later.",
		});
		const result =
			action === "request"
				? await requestPasswordReset("ada@example.test", request)
				: await submitPasswordReset("token", "new-password-456", request);
		expect(result).toEqual({
			kind: "error",
			message:
				"Zu viele Versuche zum Zurücksetzen. Warte ein paar Minuten und versuch es erneut.",
		});
	} finally {
		overwriteGetLocale(originalGetLocale);
	}
});
