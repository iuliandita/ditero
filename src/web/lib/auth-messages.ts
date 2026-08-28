// Better Auth answers a rejected request with a stable machine code alongside
// its English prose (`{"message":"Invalid email or password","code":
// "INVALID_EMAIL_OR_PASSWORD"}`), so the code -- not the prose -- is what we
// localize. Same shape as channel-messages.ts: a string-keyed map read through
// Object.hasOwn, since the code arrives over the wire and a bare index would
// resolve inherited Object keys.

import { m } from "../../paraglide/messages.js";

export type AuthErrorLike = {
	code?: string | null;
	message?: string | null;
};

const AUTH_ERROR_MESSAGES: Record<string, () => string> = {
	INVALID_EMAIL_OR_PASSWORD: m.auth_error_invalid_email_or_password,
	INVALID_PASSWORD: m.auth_error_invalid_password,
	USER_ALREADY_EXISTS: m.auth_error_user_already_exists,
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
		m.auth_error_user_already_exists_use_another_email,
	PASSWORD_TOO_SHORT: m.auth_error_password_too_short,
	PASSWORD_TOO_LONG: m.auth_error_password_too_long,
	INVALID_EMAIL: m.auth_error_invalid_email,
	VALIDATION_ERROR: m.auth_error_validation_error,
	EMAIL_NOT_VERIFIED: m.auth_error_email_not_verified,
	UNAUTHORIZED: m.auth_error_unauthorized,
	SESSION_EXPIRED: m.auth_error_session_expired,
	SESSION_NOT_FRESH: m.auth_error_session_not_fresh,
	INVALID_CODE: m.auth_error_invalid_code,
	INVALID_BACKUP_CODE: m.auth_error_invalid_backup_code,
	INVALID_TWO_FACTOR_COOKIE: m.auth_error_invalid_two_factor_cookie,
	TOTP_NOT_ENABLED: m.auth_error_totp_not_enabled,
	TWO_FACTOR_NOT_ENABLED: m.auth_error_two_factor_not_enabled,
	BACKUP_CODES_NOT_ENABLED: m.auth_error_backup_codes_not_enabled,
	TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
		m.auth_error_too_many_attempts_request_new_code,
	ACCOUNT_TEMPORARILY_LOCKED: m.auth_error_account_temporarily_locked,
	CHALLENGE_NOT_FOUND: m.auth_error_challenge_not_found,
	PASSKEY_NOT_FOUND: m.auth_error_passkey_not_found,
	AUTHENTICATION_FAILED: m.auth_error_authentication_failed,
	PREVIOUSLY_REGISTERED: m.auth_error_previously_registered,
	REGISTRATION_CANCELLED: m.auth_error_registration_cancelled,
	AUTH_CANCELLED: m.auth_error_auth_cancelled,
	FAILED_TO_VERIFY_REGISTRATION: m.auth_error_failed_to_verify_registration,
	SESSION_REQUIRED: m.auth_error_session_required,
	// Ditero's own registration gate (src/auth/registration.ts) rides the same
	// map: its refusals are configuration, and an operator reading "sign up
	// failed" concludes the app is broken.
	REGISTRATION_INVITE_REQUIRED: m.auth_error_registration_invite_required,
	REGISTRATION_DISABLED: m.auth_error_registration_disabled,
	// Same 403 as the gate, wholly different cause: the browser reached the app
	// on an address the server does not trust (TRUSTED_ORIGINS / BETTER_AUTH_URL).
	INVALID_ORIGIN: m.auth_error_invalid_origin,
};

// Precedence is deliberate. An unmapped code still yields the server's English
// prose rather than a generic keyed string: losing the specific reason is worse
// than losing the language, and Better Auth adds codes faster than this map
// tracks them. `fallback` covers a response carrying neither.
export function authErrorMessage(
	error: AuthErrorLike | null | undefined,
	fallback: () => string,
): string {
	const code = error?.code;
	if (code && Object.hasOwn(AUTH_ERROR_MESSAGES, code)) {
		return AUTH_ERROR_MESSAGES[code]();
	}
	return error?.message ?? fallback();
}
