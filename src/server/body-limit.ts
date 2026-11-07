import {
	corsPolicy,
	fixtureConnectionHeaders,
	securityHeaders,
} from "./http-policy.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const authBodies = new WeakMap<Request, Uint8Array<ArrayBuffer>>();

export function admittedAuthRequest(request: Request): Request {
	const body = authBodies.get(request);
	// Bun 1.3.14 stalls header-rewritten requests after their clone is drained.
	return body ? new Request(request, { body }) : request;
}

export function requestBodyLimit(request: Request): number | null {
	const path = new URL(request.url).pathname;
	// Signed listeners enforce their own limit after rate limiting, on raw bytes.
	if (
		/^\/api\/notifications\/(?:slack\/interactions|discord\/interactions|telegram\/webhook)\/?$/.test(
			path,
		)
	)
		return null;
	// Zero combines an offline client's pending pushes into one authenticated POST.
	if (/^\/api\/zero\/(?:mutate|push)\/?$/.test(path)) return null;
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
	return MIB;
}

export async function enforceRequestBodyLimit({
	request,
}: {
	request: Request;
}): Promise<Response | undefined> {
	const limit = requestBodyLimit(request);
	if (limit === null) return;
	const headers: Record<string, string> = {
		...securityHeaders(process.env),
		...fixtureConnectionHeaders(process.env),
		"cache-control": "no-store",
	};
	const origin = request.headers.get("origin");
	const policy = corsPolicy(process.env);
	if (
		origin &&
		Array.isArray(policy.origin) &&
		policy.origin.includes(origin)
	) {
		headers["access-control-allow-origin"] = origin;
		headers["access-control-allow-credentials"] = "true";
		headers.vary = "Origin";
	}
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
			{ status, headers },
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
	let timer = setTimeout(abort, 5000);
	request.signal.addEventListener("abort", abort, { once: true });
	if (request.signal.aborted) abort();
	let bytes = 0;
	let reads = 0;
	const chunks: Uint8Array[] | undefined = new URL(
		request.url,
	).pathname.startsWith("/api/auth/")
		? []
		: undefined;
	try {
		while (!stopped) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength) {
				clearTimeout(timer);
				timer = setTimeout(abort, 5000);
			}
			bytes += value.byteLength;
			if (bytes > limit || ++reads > 65_536) stop(413);
			else chunks?.push(value);
		}
		if (stopped) return reject(stopped);
		if (chunks) {
			const body = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			authBodies.set(request, body);
		}
	} catch {
		stop(400);
		return reject(stopped);
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
