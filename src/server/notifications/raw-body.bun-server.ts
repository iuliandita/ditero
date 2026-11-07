// Fixture for raw-body.test.ts's runtime check. Production serves this seam
// from a real Bun HTTP server, but vitest runs the suite under Node, where
// Elysia falls back to its web-standard adapter and cannot listen at all. So
// the byte-fidelity claim is re-proved here against the runtime that ships:
// spawned by the test, prints its port, echoes back the bytes the verifier saw.
import { Elysia } from "elysia";
import { verifySlackSignature } from "../../domain/channel-signature.ts";
import { admittedAuthRequest, enforceRequestBodyLimit } from "../body-limit.ts";
import { sanitizeAuthRequest } from "../client-ip.ts";
import { RAW_BODY_ROUTE_CONFIG, rawBodyHandler } from "./raw-body.ts";

let seen = "";

const app = new Elysia().onRequest(enforceRequestBodyLimit).post(
	"/seam",
	rawBodyHandler({
		rateLimit: async () => true,
		verify: ({ raw }) => {
			seen = Buffer.from(raw).toString("hex");
			return true;
		},
		handle: () => new Response(seen),
	}),
	RAW_BODY_ROUTE_CONFIG,
);

for (const path of [
	"slack/interactions",
	"discord/interactions",
	"telegram/webhook",
]) {
	app.post(
		`/api/notifications/${path}`,
		rawBodyHandler({
			rateLimit: async () => true,
			verify: ({ raw, request }) =>
				verifySlackSignature(
					"signing-secret",
					request.headers.get("x-slack-signature") ?? "",
					request.headers.get("x-slack-request-timestamp") ?? "",
					raw,
					1_700_000_000_000,
				),
			handle: ({ raw }) => new Response(Buffer.from(raw).toString("hex")),
		}),
		RAW_BODY_ROUTE_CONFIG,
	);
}
app.all("/api/auth/*", async ({ request, server }) => {
	const authRequest = sanitizeAuthRequest(
		admittedAuthRequest(request),
		server?.requestIP(request)?.address,
		[],
	);
	return Response.json({
		body: await authRequest.json(),
		peer: authRequest.headers.get("x-ditero-client-ip"),
	});
});
app.listen(0);

console.log(`port:${app.server?.port}`);
