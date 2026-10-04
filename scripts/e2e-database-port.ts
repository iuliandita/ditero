export function e2eDatabaseURL(binding: string): string {
	const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(binding.trim());
	if (!match || Number(match[1]) > 65535)
		throw new Error("Expected one loopback E2E database port binding");
	return `postgres://postgres:pass@127.0.0.1:${match[1]}/ditero_e2e`;
}
