import { createECDH, createPrivateKey, ECDH } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { notifyAllowedPrivateCIDRs } from "../../config/notify-egress.ts";
import { resolvePinnedTarget } from "../../security/safe-http.ts";

export type PushRegistration =
	| {
			provider: "unifiedpush";
			endpoint: string;
			keys: { p256dh: string; auth: string };
	  }
	| { provider: "fcm"; token: string };
export type PushOpenInput = { notificationId: string; registrationId: string };
export type PushOpenTarget =
	| { kind: "task"; workspaceId: string; listId: string; taskId: string }
	| { kind: "workspace"; workspaceId: string };
const OPEN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export function parsePushOpen(
	body: Record<string, unknown>,
): PushOpenInput | null {
	return exact(body, ["notificationId", "registrationId"]) &&
		typeof body.notificationId === "string" &&
		OPEN_ID.test(body.notificationId) &&
		typeof body.registrationId === "string" &&
		OPEN_ID.test(body.registrationId)
		? {
				notificationId: body.notificationId,
				registrationId: body.registrationId,
			}
		: null;
}
export type PushConfiguration = {
	unifiedpush?: { publicKey: string; privateKey: string; subject: string };
	fcm?: { projectId: string; clientEmail: string; privateKey: string };
};
function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function bytes(value: unknown, size: number): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9_-]+$/.test(value) &&
		Buffer.from(value, "base64url").length === size &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}
export function parseRegistration(
	body: Record<string, unknown>,
): PushRegistration | null {
	if (body.provider === "fcm")
		return exact(body, ["provider", "token"]) &&
			typeof body.token === "string" &&
			/^[A-Za-z0-9._:-]{1,4096}$/.test(body.token)
			? { provider: "fcm", token: body.token }
			: null;
	if (
		body.provider !== "unifiedpush" ||
		!exact(body, ["provider", "endpoint", "keys"]) ||
		typeof body.endpoint !== "string" ||
		body.endpoint.length > 2048 ||
		!body.keys ||
		typeof body.keys !== "object" ||
		Array.isArray(body.keys)
	)
		return null;
	const keys = body.keys as Record<string, unknown>;
	if (
		!exact(keys, ["p256dh", "auth"]) ||
		!bytes(keys.p256dh, 65) ||
		!bytes(keys.auth, 16)
	)
		return null;
	try {
		const endpoint = new URL(body.endpoint);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username ||
			endpoint.password ||
			endpoint.hash
		)
			return null;
		// Reject invalid P-256 points, not just correctly sized byte strings.
		ECDH.convertKey(Buffer.from(keys.p256dh, "base64url"), "prime256v1");
		return {
			provider: "unifiedpush",
			endpoint: endpoint.href,
			keys: { p256dh: keys.p256dh, auth: keys.auth },
		};
	} catch {
		return null;
	}
}

export async function validatePushEndpoint(endpoint: string): Promise<void> {
	// Registration checks the same DNS/address policy as delivery. Delivery must
	// re-resolve and use safeFetch's pinned HTTPS transport, never a global fetch.
	await resolvePinnedTarget(
		new URL(endpoint).hostname,
		undefined,
		notifyAllowedPrivateCIDRs(process.env.DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS),
	);
}

export function pushConfiguration(
	env: NodeJS.ProcessEnv = process.env,
): PushConfiguration {
	const config: PushConfiguration = {};
	const publicKey = env.DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY;
	const privateKey = env.DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY;
	const subject = env.DITERO_NATIVE_PUSH_VAPID_SUBJECT;
	if (publicKey || privateKey || subject) {
		if (
			!bytes(publicKey, 65) ||
			!bytes(privateKey, 32) ||
			!subject ||
			subject.length > 2048
		)
			throw new Error("Invalid native push VAPID configuration");
		const subjectUrl = new URL(subject);
		if (
			!(
				(subjectUrl.protocol === "mailto:" &&
					/^[^\s@]+@[^\s@]+$/.test(subjectUrl.pathname)) ||
				(subjectUrl.protocol === "https:" &&
					!subjectUrl.username &&
					!subjectUrl.password &&
					!subjectUrl.hash)
			)
		)
			throw new Error("Invalid native push VAPID subject");
		const pair = createECDH("prime256v1");
		pair.setPrivateKey(Buffer.from(privateKey, "base64url"));
		if (pair.getPublicKey().toString("base64url") !== publicKey)
			throw new Error("Native push VAPID keys do not match");
		config.unifiedpush = { publicKey, privateKey, subject };
	}
	const file = env.DITERO_NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE;
	if (file) {
		const info = statSync(file);
		if (
			!info.isFile() ||
			info.size > 64 * 1024 ||
			(process.platform !== "win32" && (info.mode & 0o077) !== 0)
		)
			throw new Error(
				"Native push service account file must be private and bounded",
			);
		const account: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!account || typeof account !== "object" || Array.isArray(account))
			throw new Error("Invalid native push service account");
		const value = account as Record<string, unknown>;
		if (
			value.type !== "service_account" ||
			typeof value.project_id !== "string" ||
			!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project_id) ||
			typeof value.client_email !== "string" ||
			!value.client_email.endsWith(
				`@${value.project_id}.iam.gserviceaccount.com`,
			) ||
			typeof value.private_key !== "string"
		)
			throw new Error("Invalid native push service account");
		if (createPrivateKey(value.private_key).asymmetricKeyType !== "rsa")
			throw new Error("Invalid native push service account key");
		config.fcm = {
			projectId: value.project_id,
			clientEmail: value.client_email,
			privateKey: value.private_key,
		};
	}
	return config;
}
