// In-process ntfy stand-in for the integration replica rig. Distinct from the
// e2e stub only in lifecycle: that one is a separate process Playwright owns,
// this one lives inside the test file so assertions can read the wire directly.
//
// node:http rather than Bun.serve: vitest runs the test file in a worker, and
// the Bun global is not reliably present there.
import { createServer, type Server } from "node:http";

export type Delivery = {
	topic: string;
	title: string;
	body: string;
	actions: string | null;
	ackUrl: string | null;
	at: number;
};

// The Actions header quotes every non-constant field (adapters/ntfy.ts), so the
// URL is the second quoted value: `http, "Done", "<url>", method=POST, ...`.
export function parseAckUrl(actions: string | null): string | null {
	if (!actions) return null;
	// Unrolled rather than the ambiguous `(?:[^"\\]|\\.)*`, which CodeQL flags as
	// js/polynomial-redos. Measured: both forms cost the same here, because the
	// quadratic term is matchAll retrying every start position against an
	// unterminated quote, not the inner alternation. The unrolled form is still
	// the correct shape; the input is a header this suite's own stub captured.
	const quoted = [...actions.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) =>
		m[1].replace(/\\(.)/g, "$1"),
	);
	return quoted.find((value) => /^https?:\/\//.test(value)) ?? null;
}

export type NtfyTap = {
	url: string;
	deliveries: Delivery[];
	close(): Promise<void>;
};

export async function startNtfyTap(
	host: string,
	port: number,
): Promise<NtfyTap> {
	const deliveries: Delivery[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			if (request.method === "POST") {
				const actions = request.headers.actions;
				const actionsHeader = Array.isArray(actions)
					? actions.join(", ")
					: (actions ?? null);
				const title = request.headers["x-title"];
				deliveries.push({
					topic: (request.url ?? "/").replace(/^\/+/, ""),
					title: Array.isArray(title) ? title.join("") : (title ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
					actions: actionsHeader,
					ackUrl: parseAckUrl(actionsHeader),
					at: Date.now(),
				});
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{}");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	return {
		url: `http://${host}:${port}`,
		deliveries,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
