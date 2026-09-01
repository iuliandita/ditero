import {
	aadId,
	aadKeyVersion,
	decryptWrapped,
	encryptWrapped,
	joinAad,
	KEY_BYTES,
} from "./envelope.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
} from "./wire.ts";

export type InviteFragmentContext = {
	inviteId: string;
	workspaceId: string;
	keyVersion: number;
	intendedEmail: string;
	expiresAt: string;
};

export type SealedInviteFragment = {
	fragment: string;
	payload: string;
};

function canonicalExpiry(value: string): string {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new Error("invite-fragment: expiresAt must be an ISO instant");
	}
	return value;
}

function fragmentAad(context: InviteFragmentContext): Uint8Array {
	return joinAad([
		"ditero:invite-wdk:v1",
		aadId("inviteId", context.inviteId),
		aadId("workspaceId", context.workspaceId),
		aadKeyVersion(context.keyVersion),
		aadId("intendedEmail", context.intendedEmail.trim().toLowerCase()),
		aadId("expiresAt", canonicalExpiry(context.expiresAt)),
	]);
}

export async function sealInviteFragment(
	wdk: Uint8Array,
	context: InviteFragmentContext,
): Promise<SealedInviteFragment> {
	if (wdk.length !== KEY_BYTES) {
		throw new Error(`invite-fragment: WDK must be ${KEY_BYTES} bytes`);
	}
	const secret = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	return {
		fragment: encodeBytes(secret),
		payload: encodeWrapped(
			await encryptWrapped(wdk, secret, fragmentAad(context)),
		),
	};
}

export async function openInviteFragment(
	fragment: string,
	payload: string,
	context: InviteFragmentContext,
	now: Date = new Date(),
): Promise<Uint8Array> {
	const expiry = canonicalExpiry(context.expiresAt);
	if (now.getTime() >= new Date(expiry).getTime()) {
		throw new Error("Invite fragment has expired");
	}
	const secret = decodeBytes(fragment);
	if (secret.length !== KEY_BYTES) {
		throw new Error(`invite-fragment: secret must be ${KEY_BYTES} bytes`);
	}
	const wdk = await decryptWrapped(
		decodeWrapped(payload),
		secret,
		fragmentAad(context),
	);
	if (wdk.length !== KEY_BYTES) {
		throw new Error(`invite-fragment: WDK must be ${KEY_BYTES} bytes`);
	}
	return wdk;
}
