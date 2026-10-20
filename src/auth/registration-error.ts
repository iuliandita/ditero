import { APIError } from "better-auth";
import { RegistrationDeniedError } from "./registration.ts";

export function registrationAPIError(error: unknown, path?: string): APIError {
	const denied = error instanceof RegistrationDeniedError;
	return new APIError("FORBIDDEN", {
		// Better Auth's OAuth account creation catches APIError and keeps only
		// message, replacing spaces with underscores in the callback redirect.
		message:
			denied && path?.startsWith("/callback/")
				? error.code
				: error instanceof Error
					? error.message
					: "Registration denied",
		code: denied ? error.code : undefined,
	});
}
