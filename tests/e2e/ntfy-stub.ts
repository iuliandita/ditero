// Minimal ntfy stand-in for the notifications e2e. Kept out of src/ on
// purpose: the alternative was a DITERO_E2E-gated echo route inside the real
// server, which is test-only code shipped in the product image.
//
// Topics:
//   /reject-me       -> always 401 (the failed-test-send path)
//   /e2e-keep*       -> 401 unless the expected bearer token arrives. Without
//                       this, a mask/restore bug that DROPS the stored token
//                       still gets a 200 here and the "preserves it" test
//                       passes against a broken restore.
//   anything else    -> 200
const port = Number(process.env.NTFY_STUB_PORT ?? 4599);

// Matches TOKEN in notifications.spec.ts.
const EXPECTED_TOKEN = "tk_e2e_secret_value";

Bun.serve({
	port,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/health") {
			return new Response("ok");
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (pathname === "/reject-me") return new Response("no", { status: 401 });
		if (pathname.startsWith("/e2e-keep")) {
			const auth = request.headers.get("authorization");
			if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
				return new Response("unauthorized", { status: 401 });
			}
		}
		return new Response("{}", {
			headers: { "content-type": "application/json" },
		});
	},
});

console.log(`ntfy stub on :${port}`);
