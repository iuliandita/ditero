import { CliError, parseArguments } from "./arguments.ts";
import { discover, type Fetcher } from "./client.ts";

export const HELP = `Ditero read-only CLI

Usage: ditero <command> [options]
Commands: profile, workspaces, lists, tasks, people, labels, views, dashboards

Options:
  --json                  Compact JSON output (default: formatted JSON)
  --server <origin>       HTTPS server origin; defaults to DITERO_URL
  --allow-loopback-http   Allow HTTP only for localhost, 127.0.0.1, or [::1]
  --limit <1..100>        Collection page size (default: 50)
  --cursor <cursor>       Continue a collection with its opaque nextCursor
  --all                   Read up to 100 pages and 20 MiB before printing
  --workspace <id>        Filter a collection by workspace
  --list <id>             Filter tasks by list
  --done <true|false>     Filter tasks by completion
  --help                  Show this help without accessing the server

Set DITERO_TOKEN through the environment. Credentials are never accepted as flags.
Exit codes: 0 success, 2 usage/request, 3 authentication, 4 permission,
5 missing resource, 6 rate limit, 7 network, 8 invalid/bounded response, 9 server.
`;

export async function runCli(
	argv: string[],
	env: Record<string, string | undefined>,
	output: { stdout: (text: string) => void; stderr: (text: string) => void },
	fetcher?: Fetcher,
): Promise<number> {
	const json = argv.includes("--json");
	try {
		const options = parseArguments(argv, env);
		if (!options) {
			output.stdout(HELP);
			return 0;
		}
		const result = await discover(options, fetcher);
		output.stdout(
			`${JSON.stringify(result, null, options.json ? undefined : 2)}\n`,
		);
		return 0;
	} catch (error) {
		const failure =
			error instanceof CliError
				? error
				: new CliError(
						"internal_error",
						"The command could not be completed.",
						9,
					);
		output.stderr(
			json
				? `${JSON.stringify({ version: 1, error: { code: failure.code, status: failure.status, message: failure.message } })}\n`
				: `${failure.message}\n`,
		);
		return failure.exitCode;
	}
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2), process.env, {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
}
