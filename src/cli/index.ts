import { clientVersion } from "../clients/build-info.ts";
import { CliError, parseArguments } from "./arguments.ts";
import { discover, type Fetcher } from "./client.ts";
import { type StdinReader, taskWorkflow } from "./task-workflow.ts";

export const HELP = `Ditero CLI

Usage: ditero <command> [options]
Commands: profile, workspaces, lists, tasks, people, labels, views, dashboards,
          plan-task (task intent JSON stdin), create-task (API task JSON stdin),
          complete-task (observed completion JSON stdin)

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
  --task <id>            Required only for complete-task; use the observed task ID
  --request-id <UUID>     Required for writes; preserve for exact retries
  --version               Show build identity without accessing the server
  --help                  Show this help without accessing the server

Set DITERO_TOKEN through the environment. Credentials are never accepted as flags.
Exit codes: 0 success, 2 usage/request, 3 authentication, 4 permission,
5 missing resource, 6 rate limit, 7 network, 8 invalid/bounded response, 9 server,
10 request ID conflict, 11 original task deleted.
Planning never writes; create-task and complete-task make one POST without retries.
Completion requires the inspected listId and expectedDueAt; recurring tasks advance.
Workflow stdin is at most 64 KiB. No files, invitations, or mentions are supported.
`;

export async function runCli(
	argv: string[],
	env: Record<string, string | undefined>,
	output: { stdout: (text: string) => void; stderr: (text: string) => void },
	fetcher?: Fetcher,
	stdinReader?: StdinReader,
): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		output.stdout(clientVersion("ditero"));
		return 0;
	}
	const json = argv.includes("--json");
	try {
		const options = parseArguments(argv, env);
		if (!options) {
			output.stdout(HELP);
			return 0;
		}
		const result = ["plan-task", "create-task", "complete-task"].includes(
			options.command,
		)
			? await taskWorkflow(options, fetcher, stdinReader)
			: await discover(options, fetcher);
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
				? `${JSON.stringify({ version: 1, error: { code: failure.code, status: failure.status, message: failure.message, ...(failure.choices ? { choices: failure.choices } : {}) } })}\n`
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
