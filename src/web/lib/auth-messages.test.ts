import { describe, expect, test } from "vitest";
import { m } from "../../paraglide/messages.js";
import { authErrorMessage } from "./auth-messages.ts";

// Expected values are catalog literals, not `m.*()`: routing both sides through
// the same message passes even against an emptied entry. The codes here are the
// ones a live server actually returned, not the ones the library declares.

const fallback = () => "FALLBACK";

describe("authErrorMessage", () => {
	test("localizes a known code instead of echoing the server prose", () => {
		expect(
			authErrorMessage(
				{
					code: "INVALID_EMAIL_OR_PASSWORD",
					message: "Invalid email or password",
				},
				fallback,
			),
		).toBe("Incorrect email or password.");
	});

	// The point of the issue: the English prose must lose to the mapped code,
	// not win over it the way `error.message ?? m.fallback()` did.
	test("the code beats the message even when both are present", () => {
		const result = authErrorMessage(
			{ code: "PASSWORD_TOO_SHORT", message: "Password too short" },
			fallback,
		);
		expect(result).toBe("That password is too short.");
		expect(result).not.toBe("Password too short");
	});

	// Deliberate: a code this map has not caught up with still carries its
	// specific reason, in English, rather than collapsing to a generic string.
	test("an unmapped code keeps the server's specific reason", () => {
		expect(
			authErrorMessage(
				{ code: "SOME_FUTURE_CODE", message: "Something specific went wrong" },
				fallback,
			),
		).toBe("Something specific went wrong");
	});

	test("falls back only when there is neither code nor message", () => {
		expect(authErrorMessage({}, fallback)).toBe("FALLBACK");
		expect(authErrorMessage(null, fallback)).toBe("FALLBACK");
		expect(authErrorMessage(undefined, fallback)).toBe("FALLBACK");
	});

	// The code arrives over the wire, so a bare index would resolve inherited
	// Object keys and return a function instead of a string.
	test("an inherited Object key is not treated as a mapped code", () => {
		expect(
			authErrorMessage({ code: "constructor", message: "wire junk" }, fallback),
		).toBe("wire junk");
		expect(
			authErrorMessage({ code: "toString", message: null }, fallback),
		).toBe("FALLBACK");
	});

	// #193: both are 403s and neither carried a code before, so the form showed
	// the same flat string for a working invite-only instance and a genuinely
	// misconfigured one.
	test("names the invite-only gate rather than a generic failure", () => {
		expect(
			authErrorMessage(
				{
					code: "REGISTRATION_INVITE_REQUIRED",
					message: "Registration requires an invitation",
				},
				fallback,
			),
		).toBe(
			"This instance only accepts new accounts by invitation. Ask an admin to invite you.",
		);
	});

	test("distinguishes an untrusted origin from the registration gate", () => {
		const origin = authErrorMessage(
			{ code: "INVALID_ORIGIN", message: "Invalid origin" },
			fallback,
		);
		const gate = authErrorMessage(
			{ code: "REGISTRATION_DISABLED", message: "Registration is disabled" },
			fallback,
		);
		expect(origin).toBe(
			"This address is not trusted by the server. Ask the operator to add it to the instance's trusted origins.",
		);
		expect(gate).toBe("New accounts are turned off on this instance.");
		expect(origin).not.toBe(gate);
	});

	test("resolves in the caller's locale, not the import-time one", () => {
		expect(m.auth_error_invalid_email_or_password({}, { locale: "de" })).toBe(
			"E-Mail-Adresse oder Passwort ist falsch.",
		);
		expect(m.auth_error_session_required({}, { locale: "fr" })).toBe(
			"Connecte-toi avant d'ajouter une passkey.",
		);
	});
});
