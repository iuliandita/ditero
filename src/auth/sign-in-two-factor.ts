import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function signInTwoFactor() {
	const plugin = twoFactor({
		issuer: "Ditero",
		allowPasswordless: true,
		accountLockout: {
			enabled: true,
			maxFailedAttempts: 5,
			durationSeconds: 15 * 60,
		},
	});
	const challenge = plugin.hooks.after[0];
	const handler = challenge.handler;
	challenge.handler = Object.assign(
		(context: HookContext) => {
			const headers = new Headers(context.headers ?? context.request?.headers);
			const trusted = context.context.createAuthCookie("trust_device").name;
			// A remembered device must not bypass the enrolled local factor.
			headers.set(
				"cookie",
				(headers.get("cookie") ?? "")
					.split(";")
					.filter((cookie) => cookie.trim().split("=", 1)[0] !== trusted)
					.join(";"),
			);
			return handler({ ...context, headers });
		},
		{ options: handler.options },
	) as typeof handler;
	const federated = (path = "") =>
		path.startsWith("/callback/") ||
		path.startsWith("/oauth2/callback/") ||
		path.startsWith("/sso/callback") ||
		path.startsWith("/sso/saml2/sp/acs/") ||
		path === "/sign-in/social" ||
		path === "/passkey/verify-authentication";
	const passwordMatcher = challenge.matcher;
	challenge.matcher = (context) =>
		passwordMatcher(context) || federated(context.path);
	// Retain the plugin's session deletion, challenge storage and attempt limits.
	plugin.hooks.after.push({
		matcher: (context) => federated(context.path),
		handler: createAuthMiddleware(async (context) => {
			const returned = context.context.returned as
				| { twoFactorRedirect?: boolean }
				| undefined;
			if (!returned?.twoFactorRedirect) return undefined;
			const location = context.context.responseHeaders?.get("location");
			if (!location) return undefined;
			const origin = new URL(context.context.baseURL).origin;
			const destination = new URL(location, origin);
			const page = new URL("/two-factor", origin);
			// Extra trusted auth origins must not become browser return destinations.
			if (
				destination.origin === origin &&
				destination.pathname !== page.pathname
			)
				page.searchParams.set(
					"callbackURL",
					destination.pathname + destination.search + destination.hash,
				);
			throw context.redirect(page.href);
		}),
	});
	return plugin;
}
