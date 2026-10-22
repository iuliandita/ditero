import { describe, expect, it } from "vitest";
import {
	isAppleRelayEmail,
	oauthRegistrationScope,
	refineOAuthDenial,
} from "./oauth-registration.ts";
import { RegistrationDeniedError } from "./registration.ts";

describe("oauthRegistrationScope", () => {
	it.each([
		["/sign-up/email", false, { oauth: false, inviteByEmail: true }],
		[undefined, false, { oauth: false, inviteByEmail: true }],
		["/callback/github", true, { oauth: true, inviteByEmail: true }],
		["/callback/github", false, { oauth: true, inviteByEmail: false }],
		["/sign-in/social", false, { oauth: true, inviteByEmail: false }],
		["/oauth2/callback/x", false, { oauth: true, inviteByEmail: false }],
	])("%s verified=%s", (path, verified, expected) => {
		expect(oauthRegistrationScope(path, verified)).toEqual(expected);
	});
});

describe("Apple relay refinement", () => {
	const invite = new RegistrationDeniedError(
		"REGISTRATION_INVITE_REQUIRED",
		"Registration requires an invitation",
	);

	it("recognizes only the relay domain", () => {
		expect(isAppleRelayEmail("abc@privaterelay.appleid.com")).toBe(true);
		expect(isAppleRelayEmail("ABC@PrivateRelay.AppleID.com")).toBe(true);
		expect(isAppleRelayEmail("abc@evil-privaterelay.appleid.com.example")).toBe(
			false,
		);
	});

	it("only rewrites an OAuth invitation refusal for a relay address", () => {
		const relay = "abc@privaterelay.appleid.com";
		expect(refineOAuthDenial(invite, relay, true)).toMatchObject({
			code: "REGISTRATION_RELAY_EMAIL",
		});
		expect(refineOAuthDenial(invite, relay, false)).toBe(invite);
		expect(refineOAuthDenial(invite, "a@example.test", true)).toBe(invite);
		const disabled = new RegistrationDeniedError(
			"REGISTRATION_DISABLED",
			"Registration is disabled",
		);
		expect(refineOAuthDenial(disabled, relay, true)).toBe(disabled);
	});
});
