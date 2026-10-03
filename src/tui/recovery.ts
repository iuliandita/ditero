export interface RetryRecord {
	requestId: string;
	endpoint: string;
	body: unknown;
}

export function serializeRetryRecord(record: RetryRecord): string {
	return JSON.stringify(record).replace(
		/[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
