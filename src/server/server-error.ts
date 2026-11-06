import { randomUUID } from "node:crypto";

export function serverErrorResponse(
	error: unknown,
	code = "internal-error",
): Response {
	const correlationId = randomUUID();
	console.error("HTTP request failed", { correlationId, error });
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
