export async function httpErrorMessage(
	response: Response,
	fallback: string,
	jsonMessage = false,
): Promise<string> {
	if (response.status >= 500) return fallback;
	const text = (await response.text()).trim();
	if (
		jsonMessage &&
		response.headers.get("content-type")?.includes("application/json")
	) {
		const data = JSON.parse(text) as { message?: unknown };
		return typeof data.message === "string" && data.message
			? data.message
			: fallback;
	}
	return text || fallback;
}
