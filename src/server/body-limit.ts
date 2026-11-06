const KIB = 1024;
const MIB = KIB * KIB;

export function requestBodyLimit(request: Request): number | null {
	const path = new URL(request.url).pathname;
	// Upload handlers count ciphertext bytes; import plans have their own envelope cap.
	if (
		(request.method === "PUT" || request.method === "POST") &&
		/^\/api\/(?:native\/)?attachments\/[^/]+\/(?:upload|thumbnail)\/?$/.test(
			path,
		)
	)
		return null;
	if (
		request.method === "POST" &&
		/^\/api\/portability\/import\/plans\/?$/.test(path)
	)
		return null;
	if (/^\/api\/auth\/sso\/saml2\/sp\/acs\/[\w-]+\/?$/.test(path)) return MIB;
	if (path.startsWith("/api/auth/")) return 64 * KIB;
	if (path.startsWith("/api/zero/")) return 4 * MIB;
	return MIB;
}

export async function enforceRequestBodyLimit({
	request,
}: {
	request: Request;
}): Promise<Response | undefined> {
	const limit = requestBodyLimit(request);
	if (limit === null) return;
	const reject = (status: number) =>
		Response.json(
			{
				code:
					status === 413
						? "request-limit"
						: status === 408
							? "request-timeout"
							: "invalid-request",
			},
			{ status, headers: { "cache-control": "no-store" } },
		);
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) ||
			!Number.isSafeInteger(Number(declared)) ||
			Number(declared) > limit)
	)
		return reject(413);
	if (!request.body) return;
	const reader = request.clone().body?.getReader();
	if (!reader) return;
	let stopped = 0;
	const stop = (status: number) => {
		stopped ||= status;
		void reader.cancel().catch(() => {});
		void request.body?.cancel().catch(() => {});
	};
	const abort = () => stop(408);
	const timer = setTimeout(abort, 5000);
	request.signal.addEventListener("abort", abort, { once: true });
	if (request.signal.aborted) abort();
	let bytes = 0;
	let reads = 0;
	try {
		while (!stopped) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit || ++reads > 65_536) stop(413);
		}
		if (stopped) return reject(stopped);
	} catch {
		stop(400);
		return reject(stopped);
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
