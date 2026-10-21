import {
	assertRegistrationAllowed,
	RegistrationDeniedError,
	type RegistrationMode,
} from "./registration.ts";

const APPLE_RELAY_DOMAIN = "@privaterelay.appleid.com";

export function isAppleRelayEmail(email: string): boolean {
	return email.toLowerCase().endsWith(APPLE_RELAY_DOMAIN);
}

// Anything other than an email sign-up (or an internal call with no path) is a
// provider callback, where the address is only as good as the provider's own
// verified claim. An unverified address must not satisfy an email invitation.
export function oauthRegistrationScope(
	path: string | undefined,
	emailVerified: boolean,
): { oauth: boolean; inviteByEmail: boolean } {
	const oauth = path !== undefined && path !== "/sign-up/email";
	return { oauth, inviteByEmail: !oauth || emailVerified };
}

// Apple's "hide my email" address can never equal the address an invitation was
// sent to, so say so instead of reporting a plain missing invitation.
export function refineOAuthDenial(
	error: unknown,
	email: string,
	oauth: boolean,
): unknown {
	if (
		oauth &&
		error instanceof RegistrationDeniedError &&
		error.code === "REGISTRATION_INVITE_REQUIRED" &&
		isAppleRelayEmail(email)
	)
		return new RegistrationDeniedError(
			"REGISTRATION_RELAY_EMAIL",
			"Apple hid the email address, so an invitation cannot be matched",
		);
	return error;
}

// One registration decision for email sign-up and for provider callbacks.
export async function assertRegistration(input: {
	mode: RegistrationMode;
	path: string | undefined;
	email: string;
	emailVerified: boolean;
	bypass: boolean;
	userCount: () => Promise<number>;
	hasInvite: (email: string) => Promise<boolean>;
}): Promise<void> {
	const scope = oauthRegistrationScope(input.path, input.emailVerified);
	try {
		const invited =
			input.bypass ||
			(scope.inviteByEmail && (await input.hasInvite(input.email)));
		assertRegistrationAllowed(input.mode, await input.userCount(), { invited });
	} catch (error) {
		throw refineOAuthDenial(error, input.email, scope.oauth);
	}
}
