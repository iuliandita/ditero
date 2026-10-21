import {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
} from "../../auth/password-policy.ts";
import { m } from "../../paraglide/messages.js";
import { authErrorMessage } from "./auth-messages.ts";

export const RESET_PAGE_PATH = "/reset-password";

type RequestFunction = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ResetLink =
	| { kind: "token"; token: string }
	| { kind: "invalid" }
	| { kind: "none" };

// Better Auth's link check redirects here with either `?token=` or
// `?error=INVALID_TOKEN` (unknown, expired or already used).
export function readResetLink(search: string): ResetLink {
	const query = new URLSearchParams(search);
	if (query.get("error")) return { kind: "invalid" };
	const token = query.get("token");
	return token ? { kind: "token", token } : { kind: "none" };
}

export function newPasswordProblem(
	password: string,
	confirmation: string,
): string | null {
	if (password.length < PASSWORD_MIN_LENGTH)
		return m.auth_error_password_too_short();
	if (password.length > PASSWORD_MAX_LENGTH)
		return m.auth_error_password_too_long();
	if (password !== confirmation) return m.reset_password_mismatch();
	return null;
}

async function post(
	request: RequestFunction,
	path: string,
	body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	const response = await request(path, {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		response,
		body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
	};
}

// The server answers a known and an unknown address identically; so does this.
export async function requestPasswordReset(
	email: string,
	request: RequestFunction = fetch,
): Promise<{ kind: "sent" } | { kind: "error"; message: string }> {
	const { response, body } = await post(
		request,
		"/api/auth/request-password-reset",
		{ email, redirectTo: RESET_PAGE_PATH },
	);
	if (response.ok) return { kind: "sent" };
	if (body.code === "MAIL_NOT_CONFIGURED")
		return { kind: "error", message: m.auth_mail_not_configured() };
	return {
		kind: "error",
		message: authErrorMessage(
			body as { code?: string; message?: string },
			m.reset_request_failed,
		),
	};
}

export type RevokedCredential =
	| "accessTokens"
	| "calendarFeeds"
	| "passkeys"
	| "linkedAccounts";

const REVOKED_ORDER: RevokedCredential[] = [
	"accessTokens",
	"calendarFeeds",
	"passkeys",
	"linkedAccounts",
];

export type ResetOutcome =
	| { kind: "done"; revoked: RevokedCredential[] }
	| { kind: "invalid" }
	| { kind: "error"; message: string };

export async function submitPasswordReset(
	token: string,
	newPassword: string,
	request: RequestFunction = fetch,
): Promise<ResetOutcome> {
	const { response, body } = await post(request, "/api/auth/reset-password", {
		token,
		newPassword,
	});
	if (response.ok) {
		const revoked = (body.revoked ?? {}) as Record<string, unknown>;
		return {
			kind: "done",
			revoked: REVOKED_ORDER.filter(
				(key) =>
					Object.hasOwn(revoked, key) &&
					typeof revoked[key] === "number" &&
					revoked[key] > 0,
			),
		};
	}
	if (body.code === "INVALID_TOKEN") return { kind: "invalid" };
	return {
		kind: "error",
		message: authErrorMessage(
			body as { code?: string; message?: string },
			m.reset_failed,
		),
	};
}
