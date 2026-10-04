import { CliError, parseArguments } from "../cli/arguments.ts";
import { discover } from "../cli/client.ts";
import { clientVersion } from "../clients/build-info.ts";
import { isSupportedLocale, type Locale } from "../domain/locale.ts";
import {
	PUBLIC_API_RESOURCES,
	type PublicApiResource,
	publicApiProfileSchema,
} from "../domain/public-api-resources.ts";
import * as m from "../paraglide/messages.js";
import { terminalApi } from "./api.ts";
import { TerminalController } from "./controller.ts";
import { serializeRetryRecord } from "./recovery.ts";
import { renderFrame, safeText, wrapLines } from "./render.ts";
import { createTerminalSession } from "./terminal.ts";

export const HELP = `Ditero terminal client

Usage: ditero-tui [--server HTTPS_ORIGIN] [--locale en|de|es|fr|ro|ar]
                  [--allow-loopback-http]

Set DITERO_URL and DITERO_TOKEN in the environment. Tokens never go on the command line.
Use an interactive terminal. Use arrows, Enter and Escape to browse.
n adds a task; c completes one; e edits; d reviews deletion. Review, then press y to send. ? shows help; q quits.
The client is online. A failed write keeps its exact request ID and body for explicit retry.
`;

export function parseTerminalArguments(
	argv: string[],
	env: Record<string, string | undefined>,
) {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return null;
	const cli: string[] = ["profile"];
	let locale: Locale | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--locale") {
			const value = argv[++index];
			if (locale || !value || !isSupportedLocale(value))
				throw new CliError(
					"invalid_arguments",
					"Choose one supported --locale.",
					2,
				);
			locale = value;
		} else if (argument === "--server") {
			cli.push(argument, argv[++index] ?? "");
		} else if (argument === "--allow-loopback-http") cli.push(argument);
		else
			throw new CliError(
				"invalid_arguments",
				"Run the terminal client with --help for usage.",
				2,
			);
	}
	const options = parseArguments(cli, env);
	if (!options)
		throw new CliError("invalid_arguments", "Invalid terminal arguments.", 2);
	return { options, locale };
}

function resourceLabel(resource: PublicApiResource, locale: Locale): string {
	const options = { locale };
	switch (resource) {
		case "workspaces":
			return m.workspace_switcher_title({}, options);
		case "folders":
			return m.field_folder({}, options);
		case "lists":
			return m.sidebar_lists_nav_label({}, options);
		case "tasks":
			return m.list_kind_tasks({}, options);
		case "people":
			return m.tui_people({}, options);
		case "labels":
			return m.task_field_labels({}, options);
		case "views":
			return m.sidebar_views_heading({}, options);
		case "dashboards":
			return m.sidebar_dashboards_heading({}, options);
	}
}

export async function runTerminal(
	argv: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(clientVersion("ditero-tui"));
		return 0;
	}
	let locale: Locale = "en";
	try {
		const parsed = parseTerminalArguments(argv, env);
		if (!parsed) {
			process.stdout.write(HELP);
			return 0;
		}
		locale = parsed.locale ?? "en";
		if (!process.stdin.isTTY || !process.stdout.isTTY || env.TERM === "dumb") {
			process.stderr.write(`${m.tui_terminal_required({}, { locale })}\n`);
			return 2;
		}
		const startup = new AbortController();
		let stopped = false;
		let crashed = false;
		let controller: TerminalController | undefined;
		let session: ReturnType<typeof createTerminalSession> | undefined;
		let finish!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const paint = () => {
			if (!session || stopped) return;
			const options = { locale };
			const state = controller?.state;
			const { columns, rows } = session.size();
			let title = "Ditero";
			let status = m.app_loading({}, options);
			let footer = m.tui_footer({}, options);
			let detail: string[] | undefined;
			if (state) {
				title = state.location
					? `Ditero / ${resourceLabel(state.location.resource, locale)}`
					: "Ditero";
				status =
					state.status === "loading" || state.status === "writing"
						? m.app_loading({}, options)
						: state.status === "empty"
							? m.list_empty({}, options)
							: m.tui_ready({}, options);
				if (state.error)
					status =
						state.error === "no_changes"
							? m.tui_edit_no_changes({}, options)
							: m.tui_error({ code: state.error }, options);
				if (state.detail)
					detail = JSON.stringify(state.detail.data, null, 2).split("\n");
				if (state.form) {
					footer = m.tui_footer_form({}, options);
					const form = state.form;
					if (form.kind === "create")
						detail = [
							m.task_detail_title_field({}, options),
							form.title,
							m.tui_due_prompt({}, options),
							form.due,
						];
					else {
						const labels = {
							title: m.task_detail_title_field({}, options),
							notes: m.task_field_notes({}, options),
							due: m.tui_due_instant_prompt({}, options),
							allDay: m.tui_all_day_prompt({}, options),
							priority: m.task_field_priority({}, options),
						};
						detail = [
							...(form.observation.snapshot.rrule !== null ||
							form.observation.snapshot.listKind === "habits"
								? [m.tui_due_edit_unavailable({}, options)]
								: []),
							labels[form.field],
							form.field === "allDay"
								? form.allDay
									? "1"
									: "0"
								: JSON.stringify(form[form.field]),
						];
					}
				}
				if (state.deletion) {
					const deletion = state.deletion;
					title = m.tui_review_delete({}, options);
					footer = m.tui_footer_form({}, options);
					detail = [
						m.task_delete_confirm(
							{ title: deletion.observation.snapshot.title },
							options,
						),
						m.tui_delete_scope({}, options),
						m.tui_delete_choice({}, options),
						`${deletion.cascade === false ? ">" : " "} 1 ${m.tui_delete_no_children({}, options)}`,
						`${deletion.cascade === true ? ">" : " "} 2 ${m.tui_delete_cascade({}, options)}`,
						...(deletion.observation.childrenState.count
							? [m.tui_delete_children_blocked({}, options)]
							: []),
						JSON.stringify(deletion.observation.childrenState),
					];
				}
				if (state.review) {
					const review = state.review;
					title =
						review.kind === "create"
							? m.tui_review_create({}, options)
							: review.kind === "complete"
								? m.tui_review_complete({}, options)
								: review.kind === "update"
									? m.tui_review_update({}, options)
									: m.tui_review_delete({}, options);
					footer = m.tui_footer_review({}, options);
					detail = [
						...(review.uncertain ? [m.tui_uncertain({}, options)] : []),
						...(review.kind === "delete"
							? [m.tui_delete_scope({}, options)]
							: []),
						...(review.kind === "complete" && review.recurring
							? [m.tui_review_recurring({}, options)]
							: []),
						...JSON.stringify(
							review.kind === "create"
								? {
										task: review.task,
										timezone: review.timezone,
										requestId: review.requestId,
									}
								: review.kind === "complete"
									? {
											title: review.title,
											task: review.task,
											requestId: review.requestId,
										}
									: {
											title: review.title,
											taskId: review.taskId,
											body: review.body,
											requestId: review.requestId,
										},
							null,
							2,
						).split("\n"),
					];
				}
				if (state.help)
					detail = [
						m.tui_help_navigation({}, options),
						m.tui_help_writes({}, options),
						m.tui_help_exit({}, options),
					];
			}
			if (detail) {
				detail = wrapLines(detail, Math.max(2, columns - 1));
				controller?.setDetailLines(detail.length);
				detail = detail.slice(state?.detailOffset ?? 0);
			} else controller?.setDetailLines(0);
			session.paint(
				renderFrame(
					{
						title,
						status,
						footer,
						rows: state?.location
							? state.entries.map((entry) => entry.label)
							: PUBLIC_API_RESOURCES.map((resource) =>
									resourceLabel(resource, locale),
								),
						selected: state?.selected ?? 0,
						detail,
					},
					columns,
					rows,
				),
			);
		};
		session = createTerminalSession({
			onKey(input) {
				if (!controller && input.type === "text" && input.text === "q") {
					session?.close();
					return;
				}
				void controller?.input(input).catch(() => {
					crashed = true;
					session?.close();
				});
			},
			onResize: paint,
			onExit(exit) {
				stopped = true;
				startup.abort();
				controller?.close();
				const review = controller?.state.review;
				if (review?.uncertain) {
					// Keep the exact retry payload without secrets or terminal commands.
					const record =
						review.kind === "update" || review.kind === "delete"
							? {
									requestId: review.requestId,
									endpoint: `/api/v1/tasks/${encodeURIComponent(review.taskId)}`,
									method:
										review.kind === "update"
											? ("PATCH" as const)
											: ("DELETE" as const),
									body: review.body,
								}
							: {
									requestId: review.requestId,
									endpoint:
										review.kind === "create"
											? "/api/v1/tasks"
											: `/api/v1/tasks/${encodeURIComponent(review.task.id)}/complete`,
									body:
										review.kind === "create"
											? review.task
											: {
													listId: review.task.listId,
													expectedDueAt: review.task.dueAt,
												},
								};
					const json = serializeRetryRecord(record);
					process.stderr.write(`${json}\n`);
				}
				finish(
					crashed || exit.reason === "error"
						? 1
						: exit.reason === "interrupt"
							? 130
							: exit.reason === "signal"
								? 143
								: 0,
				);
			},
		});
		paint();
		try {
			const result = await discover(
				parsed.options,
				fetch,
				undefined,
				startup.signal,
			);
			if (!stopped) {
				const profile = publicApiProfileSchema.parse(result.data);
				if (!parsed.locale && isSupportedLocale(profile.locale))
					locale = profile.locale;
				controller = new TerminalController(
					terminalApi(parsed.options),
					paint,
					() => session?.close(),
				);
				paint();
			}
		} catch (error) {
			if (!stopped) {
				session.close();
				process.stderr.write(
					`${m.tui_error({ code: error instanceof CliError ? error.code : "request_failed" }, { locale })}\n`,
				);
				return error instanceof CliError ? error.exitCode : 1;
			}
		}
		return await exited;
	} catch (error) {
		process.stderr.write(
			`${safeText(error instanceof CliError ? error.message : m.tui_terminal_required({}, { locale }))}\n`,
		);
		return error instanceof CliError ? error.exitCode : 1;
	}
}

if (import.meta.main) {
	const code = await runTerminal(process.argv.slice(2), process.env);
	// Restored stdin may retain the event loop; flush recovery output before exit.
	await Promise.all([
		new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
		new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
	]);
	process.exit(code);
}
