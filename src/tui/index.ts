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
import { TerminalController, type TerminalState } from "./controller.ts";
import { MAX_ORDER_ROWS } from "./ordering.ts";
import {
	commentParts,
	entryDetails,
	exactPayloadParts,
	helpDetails,
	loadedTaskCounts,
	orderDetails,
	reviewDetails,
	reviewParts,
	reviewPayload,
	taskRow,
} from "./presentation.ts";
import { serializeRetryRecord } from "./recovery.ts";
import {
	fitLine,
	renderFrame,
	safeText,
	type TextPart,
	visibleCells,
	wrapLines,
	wrapParts,
	wrapWords,
} from "./render.ts";
import { createTerminalSession } from "./terminal.ts";

export const HELP = `Ditero terminal client

Usage: ditero-tui [--server HTTPS_ORIGIN] [--locale en|de|es|fr|ro|ar]
                  [--allow-loopback-http] [--no-color] [--ascii]

Set DITERO_URL and DITERO_TOKEN in the environment. Tokens never go on the command line.
Use an interactive terminal. Use arrows, Enter and Escape to browse.
n adds a task; c completes one; e edits; d reviews deletion; m reads comments; o reorders among siblings. Review, then press y to send. ? shows help; q quits.
The client is online. A failed write keeps its exact request ID and body for explicit retry.
`;

export function parseTerminalArguments(
	argv: string[],
	env: Record<string, string | undefined>,
) {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return null;
	const cli: string[] = ["profile"];
	let locale: Locale | undefined;
	let noColor = env.NO_COLOR !== undefined;
	let ascii = false;
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
		} else if (argument === "--ascii") {
			ascii = true;
		} else if (argument === "--no-color") {
			noColor = true;
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
	return { options, locale, color: !noColor, ascii };
}

export function footerHints(
	footer: string,
	locale: Locale,
	toggle: boolean,
	exact: boolean,
	uncertain: boolean,
): string[] {
	const hints = footer.split(" | ");
	const quit = hints.find((hint) => hint.startsWith("q "));
	const help = m
		.tui_footer({}, { locale })
		.split(" | ")
		.find((hint) => hint.startsWith("? "));
	const confirmation = hints.find(
		(hint) => hint.startsWith("y ") || (uncertain && hint.startsWith("r ")),
	);
	const cancel = uncertain
		? undefined
		: hints.find((hint) => hint.startsWith("Esc "));
	const open = hints.find((hint) => hint.startsWith("Enter "));
	const contextual = hints.filter(
		(hint) =>
			![quit, confirmation, cancel, help, open].includes(hint) &&
			!hint.startsWith("Esc "),
	);
	contextual.sort((a, b) => {
		const order = ["c", "n", "e", "d", "m", "o", "Enter", "p", "r"];
		return order.indexOf(a.split(" ")[0]) - order.indexOf(b.split(" ")[0]);
	});
	return [
		confirmation,
		cancel,
		quit,
		open,
		toggle
			? exact
				? m.tui_summary_hint({}, { locale })
				: m.tui_payload_hint({}, { locale })
			: undefined,
		...contextual,
		help,
	].filter((hint): hint is string => hint !== undefined);
}

export function helpFooter(locale: Locale): string {
	return [
		m.tui_back_hint({}, { locale }),
		...m
			.tui_footer({}, { locale })
			.split(" | ")
			.filter((hint) => hint.startsWith("q ") || hint.startsWith("? ")),
	].join(" | ");
}

export function browseFooter(
	state: TerminalState | undefined,
	locale: Locale,
): string {
	const options = { locale };
	// Open comments page on their own cursor, not the task list's.
	const more = Boolean(
		state?.comments ? state.comments.nextCursor : state?.nextCursor,
	);
	return [
		m.tui_footer({}, options).split(" | ")[0],
		...(state?.comments ? [] : [m.tui_open_hint({}, options)]),
		...(state?.location || state?.detail ? [m.tui_back_hint({}, options)] : []),
		...(state?.location?.resource === "tasks" && !state.comments
			? [
					m.tui_comments_hint({}, options),
					...(state.location.listId ? [m.tui_order_hint({}, options)] : []),
				]
			: []),
		...m
			.tui_footer({}, options)
			.split(" | ")
			.filter((hint) => {
				const key = hint.split(" ")[0];
				return (
					key === "?" ||
					(key === "r" && Boolean(state?.location)) ||
					(key === "p" && more) ||
					(!state?.comments &&
						key === "n" &&
						["tasks", "lists", "dashboards"].includes(
							state?.location?.resource ?? "",
						)) ||
					(!state?.comments &&
						["c", "e", "d"].includes(key) &&
						state?.location?.resource === "tasks")
				);
			}),
	].join(" | ");
}

export function detailScrollHints(
	state: TerminalState | undefined,
	locale: Locale,
): string[] | undefined {
	if (
		!(
			state?.detail ||
			state?.comments ||
			state?.review ||
			state?.help ||
			state?.deletion ||
			state?.ordering?.plan ||
			state?.form?.kind === "update"
		)
	)
		return undefined;
	return [m.tui_scroll_hint({}, { locale }), "Up/Down | Home/End"];
}

export function listHeader(
	name: string | undefined,
	id: string,
	columns: number,
): string {
	const identity = fitLine(id, columns);
	const room = columns - visibleCells(identity) - 3;
	return name && room > 0 ? `${fitLine(name, room)} | ${identity}` : identity;
}

// Local ordering refusals send nothing; each says so and names its remedy.
// Every other code keeps the generic request-failure text.
export function terminalErrorText(code: string, locale: Locale): string {
	const options = { locale };
	switch (code) {
		case "ordering_pagination":
			return m.tui_order_error_pagination({}, options);
		case "ordering_unchanged":
			return m.tui_order_error_unchanged({}, options);
		case "ordering_stale":
			return m.tui_order_error_stale({}, options);
		case "ordering_tied":
			return m.tui_order_error_tied({}, options);
		case "ordering_bounds":
			return m.tui_order_error_bounds(
				{ limit: new Intl.NumberFormat(locale).format(MAX_ORDER_ROWS) },
				options,
			);
		case "ordering_scope":
			return m.tui_order_error_scope({}, options);
		case "ordering_duplicate":
			return m.tui_order_error_duplicate({}, options);
		case "ordering_malformed":
			return m.tui_order_error_malformed({}, options);
		case "ordering_key":
			return m.tui_order_error_key({}, options);
		case "ordering_single":
			return m.tui_order_error_single({}, options);
		default:
			return m.tui_error({ code }, options);
	}
}

export function orderingErrorDetails(
	state: TerminalState | undefined,
	locale: Locale,
	columns: number,
): string[] {
	const code = state?.error;
	if (!code?.startsWith("ordering_")) return [];
	return [
		...wrapWords(
			[terminalErrorText(code, locale)],
			Math.max(2, columns - (columns >= 80 ? 5 : 1)),
		),
		"",
	];
}

export function terminalStatusLine(
	state: TerminalState | undefined,
	fallback: string,
	locale: Locale,
	columns: number,
	count: ReturnType<typeof loadedTaskCounts>,
): string {
	const options = { locale };
	if (state?.review?.uncertain) return m.tui_status_uncertain({}, options);
	if (state?.error) {
		if (state.error === "no_changes") return m.tui_edit_no_changes({}, options);
		if (state.error === "invalid_input")
			return state.form?.kind === "update" &&
				state.form.dirty.priority &&
				!/^[0-3]$/.test(state.form.priority)
				? m.tui_invalid_priority({}, options)
				: m.tui_invalid_value({}, options);
		return terminalErrorText(state.error, locale);
	}
	if (state?.review) return m.tui_status_not_sent({}, options);
	if (state?.ordered && ["ready", "empty"].includes(state.status)) {
		const number = new Intl.NumberFormat(locale);
		const full = m.tui_order_acknowledged(
			{
				position: number.format(state.ordered.to),
				total: number.format(state.ordered.total),
			},
			options,
		);
		// The frame is one cell narrower than the terminal. A clipped full
		// sentence would lose the rank caveat, so narrow terminals get a short one.
		return visibleCells(full) <= columns - 1
			? full
			: m.tui_order_acknowledged_short({}, options);
	}
	if (state?.comments && ["ready", "empty"].includes(state.status)) {
		const number = new Intl.NumberFormat(locale);
		return [
			m.tui_loaded(
				{ count: number.format(state.comments.items.length) },
				options,
			),
			...(columns >= 60
				? [m.tui_page({ page: number.format(state.comments.page) }, options)]
				: []),
			state.comments.nextCursor
				? m.tui_more({}, options)
				: m.tui_end({}, options),
		].join(" | ");
	}
	if (state?.location && ["ready", "empty"].includes(state.status)) {
		const number = new Intl.NumberFormat(locale);
		return columns >= 80 && state.location.resource === "tasks"
			? `${m.tui_page({ page: number.format(state.page) }, options)} | ${m.tui_counts({ loaded: number.format(count.loaded), open: number.format(count.open), done: number.format(count.done), overdue: number.format(count.overdue) }, options)}`
			: `${m.tui_loaded({ count: number.format(state.entries.length) }, options)}${columns >= 60 ? ` | ${m.tui_page({ page: number.format(state.page) }, options)}` : ""}`;
	}
	return fallback;
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
	let timezone = "UTC";
	let account = "";
	let access: "read" | "write" | undefined;
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
			const context = {
				locale,
				timezone,
				now: Date.now(),
				ascii: parsed.ascii,
				columns,
			};
			let title = "Ditero";
			let status: string = m.app_loading({}, options);
			let footer: string = m.tui_footer({}, options);
			let detail: string[] | undefined;
			let detailParts: TextPart[][] | undefined;
			if (state) {
				title = state.location
					? `Ditero / ${resourceLabel(state.location.resource, locale)}`
					: "Ditero";
				status =
					state.status === "loading" || state.status === "writing"
						? m.app_loading({}, options)
						: state.status === "empty"
							? m.list_empty({}, options)
							: state.review
								? state.review.uncertain
									? m.tui_uncertain({}, options)
									: m.tui_not_sent({}, options)
								: state.location
									? `${m.tui_loaded({ count: new Intl.NumberFormat(locale).format(state.entries.length) }, options)} | ${state.nextCursor ? m.tui_more({}, options) : m.tui_end({}, options)}`
									: m.tui_ready({}, options);
				if (state.error)
					status =
						state.error === "no_changes"
							? m.tui_edit_no_changes({}, options)
							: terminalErrorText(state.error, locale);
				if (state.detail) {
					if (state.payload) detailParts = exactPayloadParts(state.detail.data);
					else detail = entryDetails(state.detail, context);
				}
				if (state.comments) {
					title = `Ditero / ${m.tui_comments_title({}, options)}`;
					detail = undefined;
					detailParts = commentParts(
						{ ...state.comments, status: state.status, error: state.error },
						context,
						state.payload,
					);
				}
				if (state.form) {
					detailParts = undefined;
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
					detailParts = undefined;
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
				if (state.ordering?.plan) {
					detailParts = undefined;
					title = m.tui_review_order({}, options);
					footer = m.tui_footer_form({}, options);
					detail = orderDetails(
						state.ordering.plan,
						state.ordering.position,
						context,
					);
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
									: review.kind === "place"
										? m.tui_review_order({}, options)
										: m.tui_review_delete({}, options);
					footer = [
						m.tui_footer({}, options).split(" | ")[0],
						review.uncertain
							? m.tui_retry_hint({}, options)
							: m.tui_confirm_hint({}, options),
						...(review.uncertain ? [] : [m.tui_cancel_hint({}, options)]),
					].join(" | ");
					detail = reviewDetails(review, context, state.payload);
					detailParts = reviewParts(review, context, state.payload);
				}
				if (state.help) {
					detailParts = undefined;
					footer = helpFooter(locale);
					detail = helpDetails(context);
				}
			}
			const presented =
				state?.entries.map((entry) => taskRow(entry, context)) ?? [];
			const count = loadedTaskCounts(state?.entries ?? [], context);
			const reportedAccess =
				state?.authorityRefused || !access
					? ""
					: access === "write"
						? m.tui_api_write({}, options)
						: m.tui_api_read({}, options);
			const breadcrumb = state?.authorityRefused
				? ""
				: state?.breadcrumb.join(parsed.ascii ? " / " : " › ") ||
					state?.location?.listId ||
					state?.location?.workspaceId ||
					"";
			const identity = state?.authorityRefused ? "" : account;
			let scope =
				columns >= 80
					? [
							identity,
							new URL(parsed.options.server).hostname,
							breadcrumb,
							state?.location || columns < 100 || rows < 30
								? reportedAccess
								: "",
						]
							.filter(Boolean)
							.join(" | ")
					: breadcrumb || new URL(parsed.options.server).hostname;
			if (
				state?.location?.resource === "tasks" &&
				state.location.listId &&
				!state.authorityRefused
			)
				scope = listHeader(
					state.breadcrumb.at(-1),
					state.location.listId,
					columns - 1,
				);
			const statusLine = terminalStatusLine(
				state,
				status,
				locale,
				columns,
				count,
			);
			if (!detail && !detailParts && state?.status === "empty")
				detail = [m.list_empty({}, options), m.tui_empty_help({}, options)];
			if (
				!state?.review &&
				!state?.form &&
				!state?.deletion &&
				!state?.ordering?.plan &&
				!state?.help
			)
				footer = browseFooter(state, locale);
			const localError = orderingErrorDetails(state, locale, columns);
			if (localError.length && !state?.help) {
				detail = [
					...localError,
					...(detail ??
						presented.map(
							(entry, index) =>
								`${index === state?.selected ? ">" : " "} ${entry.text}`,
						)),
				];
			}
			if (detailParts) {
				detailParts = wrapParts(
					detailParts,
					Math.max(2, columns - (columns >= 80 ? 5 : 1)),
				);
				controller?.setDetailLines(detailParts.length);
				detailParts = detailParts.slice(state?.detailOffset ?? 0);
			} else if (detail) {
				detail = (state?.help ? wrapWords : wrapLines)(
					detail,
					Math.max(2, columns - (columns >= 80 ? 5 : 1)),
				);
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
							? presented.map((entry) => entry.text)
							: PUBLIC_API_RESOURCES.map((resource) =>
									resourceLabel(resource, locale),
								),
						selected: state?.selected ?? 0,
						color: parsed.color,
						framed: true,
						ascii: parsed.ascii,
						context: scope,
						statusLine,
						viewportTitle: "",
						start: !state?.location,
						startInfo: [
							clientVersion("ditero-tui").trim(),
							reportedAccess,
							m.tui_locale_info({ locale }, options),
							m.tui_glyph_info(
								{ glyphs: parsed.ascii ? "ASCII" : "Unicode" },
								options,
							),
							parsed.color
								? m.tui_color_on({}, options)
								: m.tui_color_off({}, options),
						],
						rowMetadata:
							state?.location?.resource === "tasks"
								? presented.map((entry) => entry.metadata)
								: undefined,
						rowTones: presented.map((entry) => entry.tone),
						rowParts: presented.map((entry) => entry.parts),
						rowMetadataParts: presented.map((entry) => entry.metadataParts),
						statusTone: state?.error
							? "danger"
							: state?.review?.uncertain
								? "danger"
								: state?.review
									? "warning"
									: "plain",
						footerHints: footerHints(
							footer,
							locale,
							!state?.help &&
								Boolean(state?.detail || state?.comments || state?.review),
							state?.payload ?? false,
							!state?.help && (state?.review?.uncertain ?? false),
						),
						detail,
						detailParts,
						detailOffset: state?.detailOffset,
						detailScrollHint: detailScrollHints(state, locale),
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
					const record = reviewPayload(review);
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
				timezone = profile.timezone;
				account = profile.name;
				access = profile.tokenAccess;
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
