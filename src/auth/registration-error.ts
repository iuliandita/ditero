import { APIError } from "better-auth";
import { RegistrationDeniedError } from "./registration.ts";

export function registrationAPIError(error: unknown): APIError {
	if (!(error instanceof RegistrationDeniedError)) {
		// An outage is not a policy answer: log it and keep its text off the wire.
		// The code is required: Better Auth 1.7 redirects an OAuth callback only
		// for coded errors and answers an uncoded one with a bare 500.
		console.error("registration policy check failed", error);
		return new APIError("INTERNAL_SERVER_ERROR", {
			message: "Registration is unavailable",
			code: "REGISTRATION_UNAVAILABLE",
		});
	}
	return new APIError("FORBIDDEN", {
		message: error.message,
		code: error.code,
	});
}
