import type { CORSConfig } from "@elysiajs/cors";
import { zeroPublicURL } from "./public-config.ts";

type HttpEnvironment = {
	NODE_ENV?: string;
	TRUSTED_ORIGINS?: string;
	PUBLIC_ZERO_URL?: string;
};

export function corsPolicy(env: HttpEnvironment): CORSConfig {
	if (env.NODE_ENV === "production") {
		return {
			origin: false,
			methods: false,
			credentials: false,
			preflight: false,
		};
	}

	const origins = (env.TRUSTED_ORIGINS ?? "http://localhost:5173")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
	return {
		origin: origins,
		methods: ["GET", "POST"],
		allowedHeaders: ["Content-Type", "Authorization"],
		credentials: true,
		preflight: true,
	};
}

export function securityHeaders(env: HttpEnvironment): Record<string, string> {
	if (env.NODE_ENV !== "production") return {};

	const zeroURL = new URL(zeroPublicURL(env));
	const websocketURL = new URL(zeroURL);
	websocketURL.protocol = zeroURL.protocol === "https:" ? "wss:" : "ws:";
	const contentSecurityPolicy = [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"img-src 'self' data: blob:",
		"style-src 'self' 'unsafe-inline'",
		// hash-wasm compiles WebAssembly for Argon2id. Without this narrow
		// directive deriveKek throws in production only. NOT 'unsafe-eval'.
		"script-src 'self' 'wasm-unsafe-eval'",
		`connect-src 'self' ${zeroURL.origin} ${websocketURL.origin}`,
	].join("; ");

	return {
		"content-security-policy": contentSecurityPolicy,
		"strict-transport-security": "max-age=31536000; includeSubDomains",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"referrer-policy": "strict-origin-when-cross-origin",
		"permissions-policy": "camera=(), microphone=(), geolocation=()",
	};
}
