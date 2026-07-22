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
// Scanned rather than matched. Every quote-pair regex here is polynomial, and not
// because of its own shape: matchAll restarts at each position, so an unterminated
// quote rescans the tail once per offset. Unrolling the alternation does not change
// that -- measured identical, and CodeQL flags both. A single pass does.
function quotedFields(input: string): string[] {
	const fields: string[] = [];
	for (let i = 0; i < input.length; i++) {
		if (input[i] !== '"') continue;
		let value = "";
		let j = i + 1;
		for (; j < input.length && input[j] !== '"'; j++) {
			if (input[j] === "\\" && j + 1 < input.length) j++;
			value += input[j];
		}
		if (j >= input.length) break; // unterminated: no closing quote follows
		fields.push(value);
		i = j;
	}
	return fields;
}

export function parseAckUrl(actions: string | null): string | null {
	if (!actions) return null;
	return (
		quotedFields(actions).find(
			(value) => value.startsWith("http://") || value.startsWith("https://"),
		) ?? null
	);
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
