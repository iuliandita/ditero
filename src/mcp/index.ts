import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { CliError } from "../cli/arguments.ts";
import { clientVersion } from "../clients/build-info.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

export function startMcp(
	env: Record<string, string | undefined>,
	argv: string[] = [],
) {
	const configuration = mcpConfiguration(env, argv);
	return serveStdio(() => createDiteroMcp(configuration), {
		transport: new StdioServerTransport(process.stdin, process.stdout, {
			maxBufferSize: 65_536,
		}),
		onerror: () => process.stderr.write("Ditero MCP transport error.\n"),
	});
}

if (
	import.meta.main &&
	process.argv.length === 3 &&
	process.argv[2] === "--version"
) {
	process.stdout.write(clientVersion("ditero-mcp"));
} else if (import.meta.main) {
	try {
		const handle = startMcp(process.env, process.argv.slice(2));
		let closing = false;
		const shutdown = async () => {
			if (closing) return;
			closing = true;
			try {
				await handle.close();
			} catch {
				process.stderr.write("Ditero MCP shutdown failed.\n");
				process.exitCode = 1;
			}
		};
		process.once("SIGINT", () => void shutdown());
		process.once("SIGTERM", () => void shutdown());
	} catch (error) {
		process.stderr.write(
			error instanceof CliError
				? `${error.message}\n`
				: "Ditero MCP startup failed.\n",
		);
		process.exitCode = error instanceof CliError ? error.exitCode : 1;
	}
}
