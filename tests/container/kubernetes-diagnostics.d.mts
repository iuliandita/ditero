export function capture(
	command: string,
	args: string[],
	options?: { limit?: number; timeout?: number },
): Promise<{
	output: Buffer;
	code: number | null;
	signal: NodeJS.Signals | null;
	truncated: boolean;
	timedOut: boolean;
	error?: string;
}>;
