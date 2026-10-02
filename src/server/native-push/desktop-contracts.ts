export type DesktopPushRegistration = { provider: "desktop" };
export type DesktopPushMessage = {
	version: "1";
	notificationId: string;
	registrationId: string;
};
export const DESKTOP_POLL_LIMIT = 20;
export const DESKTOP_MAILBOX_LIMIT = 500;
export function parseDesktopEnrollment(
	body: Record<string, unknown>,
): DesktopPushRegistration | null {
	return Object.keys(body).length === 0 ? { provider: "desktop" } : null;
}
export function parseDesktopRegistration(
	body: Record<string, unknown>,
): DesktopPushRegistration | null {
	return Object.keys(body).length === 1 &&
		Object.hasOwn(body, "provider") &&
		body.provider === "desktop"
		? { provider: "desktop" }
		: null;
}
export function parseDesktopPoll(
	body: Record<string, unknown>,
): { registrationId: string } | null {
	return Object.keys(body).length === 1 &&
		Object.hasOwn(body, "registrationId") &&
		typeof body.registrationId === "string" &&
		/^[A-Za-z0-9_.:-]{1,128}$/.test(body.registrationId)
		? { registrationId: body.registrationId }
		: null;
}
