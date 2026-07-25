import { m } from "../../paraglide/messages.js";

type SignInResult =
	| { kind: "signed-in" }
	| { kind: "two-factor" }
	| { kind: "error"; message: string };

type RequestFunction = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export async function signInEmail(
	email: string,
	password: string,
	request: RequestFunction = fetch,
): Promise<SignInResult> {
	const response = await request("/api/auth/sign-in/email", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	const body = (await response.json().catch(() => ({}))) as {
		message?: string;
		twoFactorRedirect?: boolean;
	};
	if (!response.ok) {
		return {
			kind: "error",
			message: body.message ?? m.login_error_sign_in_failed(),
		};
	}
	if (body.twoFactorRedirect) return { kind: "two-factor" };
	return { kind: "signed-in" };
}
