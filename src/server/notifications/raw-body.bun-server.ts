// Fixture for raw-body.test.ts's runtime check. Production serves this seam
// from a real Bun HTTP server, but vitest runs the suite under Node, where
// Elysia falls back to its web-standard adapter and cannot listen at all. So
// the byte-fidelity claim is re-proved here against the runtime that ships:
// spawned by the test, prints its port, echoes back the bytes the verifier saw.
import { Elysia } from "elysia";
import { RAW_BODY_ROUTE_CONFIG, rawBodyHandler } from "./raw-body.ts";

let seen = "";

const app = new Elysia()
	.post(
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
	)
	.listen(0);

console.log(`port:${app.server?.port}`);
