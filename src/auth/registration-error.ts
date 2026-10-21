import { APIError } from "better-auth";
import { RegistrationDeniedError } from "./registration.ts";

export function registrationAPIError(error: unknown, path?: string): APIError {
	if (!(error instanceof RegistrationDeniedError)) {
		// An outage is not a policy answer: log it and keep its text off the wire.
		console.error("registration policy check failed", error);
		return new APIError("INTERNAL_SERVER_ERROR", {
			message: "Registration is unavailable",
		});
	}
	return new APIError("FORBIDDEN", {
		// Better Auth's OAuth account creation catches APIError and keeps only
		// message, replacing spaces with underscores in the callback redirect.
		message: path?.startsWith("/callback/") ? error.code : error.message,
		code: error.code,
	});
}
