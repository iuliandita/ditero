export const DISPLAY_NAME_MAX_LENGTH = 80;

export function normalizeDisplayName(value: string): string {
	if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("INVALID_DISPLAY_NAME");
	const name = value.trim();
	if (!name || name.length > DISPLAY_NAME_MAX_LENGTH)
		throw new Error("INVALID_DISPLAY_NAME");
	return name;
}

export function signupDisplayName(value: string, email: string): string {
	if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("INVALID_DISPLAY_NAME");
	return normalizeDisplayName(value.trim() ? value : email.split("@")[0]);
}
