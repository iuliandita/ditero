import { clientVersion } from "../clients/build-info.ts";
import { CliError, parseArguments } from "./arguments.ts";
import { discover, type Fetcher } from "./client.ts";
import { COMMENT_COMMANDS, commentWorkflow } from "./comment-workflow.ts";
import { listWorkflow } from "./list-workflow.ts";
import { taskPlacementWorkflow } from "./task-placement-workflow.ts";
import { taskRelationshipsWorkflow } from "./task-relationships-workflow.ts";
import { type StdinReader, taskWorkflow } from "./task-workflow.ts";
import { WEBHOOK_COMMANDS, webhookWorkflow } from "./webhook-workflow.ts";

export const HELP = `Ditero CLI

Usage: ditero <command> [options]
Commands: profile, workspaces, lists, tasks, people, labels, views, dashboards, folders,
          create-list, update-list, delete-list (list JSON stdin),
          observe-list, observe-list-deletion (live state JSON),
          plan-task (task intent JSON stdin), create-task (API task JSON stdin),
          complete-task (observed completion JSON stdin),
          observe-task, observe-task-deletion (live state JSON),
          update-task, delete-task (observed mutation JSON stdin),
          observe-task-relationships (live scope and relationship sets),
          update-task-relationships (complete desired relationship JSON stdin),
          observe-task-placement (live placement and children state),
          place-task (observed placement JSON stdin),
          list-task-comments, observe-comment (explicit task/comment IDs),
          add-comment, edit-comment, delete-comment (observed JSON stdin),
          list-webhooks (metadata only), create-webhook (JSON stdin, shows the secret once),
          revoke-webhook (idempotent)

Options:
  --json                  Compact JSON output (default: formatted JSON)
  --server <origin>       HTTPS server origin; defaults to DITERO_URL
  --allow-loopback-http   Allow HTTP only for localhost, 127.0.0.1, or [::1]
  --limit <1..100>        Collection page size (default: 50)
  --cursor <cursor>       Continue a collection with its opaque nextCursor
  --all                   Read up to 100 pages and 20 MiB before printing
  --workspace <id>        Filter a collection by workspace
  --list <id>             Filter tasks; required for list observation/update/deletion
  --done <true|false>     Filter tasks by completion
  --task <id>            Required for task observation, completion, update, and deletion
  --comment <id>         Required for comment observation, editing and deletion
  --request-id <UUID>     Required for writes; preserve for exact retries
  --webhook <UUID>        Required for webhook revocation
  --reveal-secret         Required for create-webhook; prints the one-time secret on stdout
  --version               Show build identity without accessing the server
  --help                  Show this help without accessing the server

Set DITERO_TOKEN through the environment. Credentials are never accepted as flags.
Exit codes: 0 success, 2 usage/request, 3 authentication, 4 permission,
5 missing resource, 6 rate limit, 7 network, 8 invalid/bounded response, 9 server,
10 request ID conflict or webhook limit, 11 original task deleted.
Planning never writes; writes make one POST, PATCH, or DELETE without retries.
Completion requires the inspected listId and expectedDueAt; recurring tasks advance.
Updates require an observed state token; deletion also requires child state and explicit cascade.
Workflow stdin is at most 64 KiB; deletion, placement and list writes are at most 4 KiB. Comment writes preserve exact bodies; creation-only mentions notify current members without invitations.
Comment pages require --task and do not support --all; deletion requires comment-and-attachments.
Webhook commands take no request ID or paging, never retry, and send one request; creation JSON is at most 4 KiB.
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
		const result = WEBHOOK_COMMANDS.includes(options.command)
			? await webhookWorkflow(options, fetcher, stdinReader)
			: COMMENT_COMMANDS.some((command) => command === options.command)
				? await commentWorkflow(options, fetcher, stdinReader)
				: ["observe-task-placement", "place-task"].includes(options.command)
					? await taskPlacementWorkflow(options, fetcher, stdinReader)
					: [
								"observe-task-relationships",
								"update-task-relationships",
							].includes(options.command)
						? await taskRelationshipsWorkflow(options, fetcher, stdinReader)
						: [
									"create-list",
									"observe-list",
									"update-list",
									"observe-list-deletion",
									"delete-list",
								].includes(options.command)
							? await listWorkflow(options, fetcher, stdinReader)
							: [
										"plan-task",
										"create-task",
										"complete-task",
										"observe-task",
										"observe-task-deletion",
										"update-task",
										"delete-task",
									].includes(options.command)
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
