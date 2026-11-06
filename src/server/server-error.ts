import { randomUUID } from "node:crypto";

export function serverErrorResponse(
	error: unknown,
	code = "internal-error",
): Response {
	const correlationId = randomUUID();
	const metadata: {
		correlationId: string;
		errorClass: string;
		sqlState?: string;
	} = {
		correlationId,
		errorClass:
			error instanceof Error && /^[\w]{1,64}$/.test(error.constructor.name)
				? error.constructor.name
				: "UnknownError",
	};
	let cause = error;
	for (
		let depth = 0;
		depth < 5 && cause && typeof cause === "object";
		depth++
	) {
		if (
			"code" in cause &&
			typeof cause.code === "string" &&
			/^[0-9A-Z]{5}$/.test(cause.code)
		) {
			metadata.sqlState = cause.code;
			break;
		}
		cause = "cause" in cause ? cause.cause : undefined;
	}
	console.error("HTTP request failed", metadata);
	return Response.json(
		{ code, message: "An unexpected error occurred", correlationId },
		{
			status: 500,
			headers: {
				"cache-control": "no-store",
				"x-correlation-id": correlationId,
			},
		},
	);
}

export function handleServerError({
	code,
	error,
}: {
	code: string | number;
	error: unknown;
}): Response | undefined {
	if (code === "NOT_FOUND" || (typeof code === "number" && code < 500)) return;
	if (
		code === "PARSE" ||
		code === "VALIDATION" ||
		code === "INVALID_COOKIE_SIGNATURE"
	)
		return Response.json(
			{ code: "invalid-request" },
			{ status: code === "VALIDATION" ? 422 : 400 },
		);
	return serverErrorResponse(error);
}
