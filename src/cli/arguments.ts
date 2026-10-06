import { z } from "zod";
import {
	PUBLIC_API_ID,
	PUBLIC_API_MAX_PAGE_SIZE,
	PUBLIC_API_PAGE_SIZE,
} from "../domain/public-api.ts";
import { apiCommentIdSchema } from "../domain/public-api-comments.ts";
import {
	PUBLIC_API_RESOURCES,
	type PublicApiResource,
} from "../domain/public-api-resources.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";

export class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: number,
		readonly status: number | null = null,
		readonly choices?: { id: string; name: string }[],
	) {
		super(message);
	}
}

export interface CliOptions {
	command:
		| "list-task-comments"
		| "observe-comment"
		| "add-comment"
		| "edit-comment"
		| "delete-comment"
		| "profile"
		| "setup-status"
		| PublicApiResource
		| "observe-folder"
		| "create-folder"
		| "update-folder"
		| "delete-folder"
		| "create-list"
		| "observe-list"
		| "observe-list-deletion"
		| "delete-list"
		| "update-list"
		| "plan-task"
		| "create-task"
		| "complete-task"
		| "observe-task"
		| "observe-task-deletion"
		| "observe-task-placement"
		| "place-task"
		| "observe-task-relationships"
		| "update-task-relationships"
		| "update-task"
		| "delete-task"
		| "list-webhooks"
		| "create-webhook"
		| "revoke-webhook";
	server: string;
	token: string;
	json: boolean;
	all: boolean;
	limit: number;
	cursor?: string;
	workspaceId?: string;
	listId?: string;
	done?: string;
	requestId?: string;
	taskId?: string;
	commentId?: string;
	webhookId?: string;
	folderId?: string;
	revealSecret?: boolean;
}

export function usageError(): never {
	throw new CliError(
		"invalid_arguments",
		"Invalid arguments. Run ditero --help for usage.",
		2,
	);
}

export function canonicalServer(value: string, allowLoopback: boolean): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return usageError();
	}
	if (
		value.length > 2048 ||
		value.trim() !== value ||
		Array.from(value).some(
			(character) =>
				character === "\\" ||
				character.charCodeAt(0) <= 32 ||
				character.charCodeAt(0) === 127,
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		usageError();
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.protocol !== "https:" &&
		!(allowLoopback && loopback && url.protocol === "http:")
	)
		usageError();
	// Refuse alternate numeric/address spellings normalized by URL parsing.
	if (
		!value.startsWith(`${url.origin}`) ||
		![url.origin, `${url.origin}/`].includes(value)
	)
		usageError();
	return url.origin;
}

export function parseArguments(
	argv: string[],
	env: Record<string, string | undefined>,
): CliOptions | null {
	if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]))
		return null;
	let command: CliOptions["command"] | undefined;
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const booleans = [
		"--json",
		"--all",
		"--allow-loopback-http",
		"--reveal-secret",
	];
	const valued = [
		"--server",
		"--limit",
		"--cursor",
		"--workspace",
		"--list",
		"--done",
		"--request-id",
		"--task",
		"--comment",
		"--webhook",
		"--folder",
	];
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (booleans.includes(argument)) {
			if (flags.has(argument)) usageError();
			flags.add(argument);
		} else if (valued.includes(argument)) {
			const value = argv[++index];
			if (values.has(argument) || !value || value.startsWith("--"))
				usageError();
			values.set(argument, value);
		} else if (
			!command &&
			([
				"list-task-comments",
				"observe-comment",
				"add-comment",
				"edit-comment",
				"delete-comment",
				"profile",
				"setup-status",
				"observe-folder",
				"create-folder",
				"update-folder",
				"delete-folder",
				"create-list",
				"observe-list",
				"observe-list-deletion",
				"delete-list",
				"update-list",
				"plan-task",
				"create-task",
				"complete-task",
				"observe-task",
				"observe-task-deletion",
				"observe-task-placement",
				"place-task",
				"observe-task-relationships",
				"update-task-relationships",
				"update-task",
				"delete-task",
				"list-webhooks",
				"create-webhook",
				"revoke-webhook",
			].includes(argument) ||
				PUBLIC_API_RESOURCES.some((resource) => resource === argument))
		) {
			command = argument as CliOptions["command"];
		} else usageError();
	}
	if (!command) usageError();
	const webhookCommand = [
		"list-webhooks",
		"create-webhook",
		"revoke-webhook",
	].includes(command);
	const rawWebhook = values.get("--webhook");
	const parsedWebhook = z.uuid().safeParse(rawWebhook);
	if (
		(webhookCommand &&
			(flags.has("--all") ||
				[...values.keys()].some(
					(key) =>
						key !== "--server" &&
						!(command === "revoke-webhook" && key === "--webhook"),
				) ||
				(command === "revoke-webhook") !== parsedWebhook.success)) ||
		(!webhookCommand && rawWebhook !== undefined) ||
		(flags.has("--reveal-secret") && command !== "create-webhook")
	)
		usageError();
	const webhookId = parsedWebhook.success
		? parsedWebhook.data.toLowerCase()
		: undefined;
	const commentCommand = [
		"list-task-comments",
		"observe-comment",
		"add-comment",
		"edit-comment",
		"delete-comment",
	].includes(command);
	const commentItem = [
		"observe-comment",
		"edit-comment",
		"delete-comment",
	].includes(command);
	const folderCommand = [
		"observe-folder",
		"create-folder",
		"update-folder",
		"delete-folder",
	].includes(command);
	const folderItem = folderCommand && command !== "create-folder";
	const folderId = values.get("--folder");
	if (
		(!folderItem && folderId !== undefined) ||
		(folderItem &&
			(!PUBLIC_API_ID.safeParse(folderId).success ||
				folderId === "." ||
				folderId === ".." ||
				/[\uD800-\uDFFF]/u.test(folderId ?? "") ||
				(folderId ?? "").includes("\0")))
	)
		usageError();
	const writing = [
		"create-folder",
		"update-folder",
		"delete-folder",
		"add-comment",
		"edit-comment",
		"delete-comment",
		"place-task",
		"update-task-relationships",
		"create-list",
		"update-list",
		"delete-list",
		"create-task",
		"complete-task",
		"update-task",
		"delete-task",
	].includes(command);
	const taskCommand =
		commentCommand ||
		[
			"observe-task-placement",
			"place-task",
			"observe-task-relationships",
			"update-task-relationships",
			"complete-task",
			"observe-task",
			"observe-task-deletion",
			"update-task",
			"delete-task",
		].includes(command);
	const listCommand = [
		"observe-list",
		"update-list",
		"observe-list-deletion",
		"delete-list",
	].includes(command);
	const workflow =
		command === "plan-task" ||
		writing ||
		taskCommand ||
		listCommand ||
		folderCommand;
	if (
		workflow &&
		(flags.has("--all") ||
			[...values.keys()].some(
				(key) =>
					![
						"--server",
						...(writing ? ["--request-id"] : []),
						...(taskCommand ? ["--task"] : []),
						...(commentItem ? ["--comment"] : []),
						...(command === "list-task-comments"
							? ["--limit", "--cursor"]
							: []),
						...(listCommand ? ["--list"] : []),
						...(folderItem ? ["--folder"] : []),
					].includes(key),
			))
	)
		usageError();
	if (!writing && values.has("--request-id")) usageError();
	if (!taskCommand && values.has("--task")) usageError();
	const taskId = values.get("--task");
	if (taskCommand && !PUBLIC_API_ID.safeParse(taskId).success) usageError();
	const commentId = values.get("--comment");
	if (!commentItem && commentId !== undefined) usageError();
	if (commentCommand && !apiCommentIdSchema.safeParse(taskId).success)
		usageError();
	if (commentItem && !apiCommentIdSchema.safeParse(commentId).success)
		usageError();
	let requestId: string | undefined;
	if (writing) {
		try {
			requestId = parseApiIdempotencyKey(values.get("--request-id") ?? null);
		} catch {
			usageError();
		}
	}

	if (
		(command === "profile" || command === "setup-status") &&
		(flags.has("--all") || [...values.keys()].some((key) => key !== "--server"))
	)
		usageError();
	if (
		(command !== "tasks" && !listCommand && values.has("--list")) ||
		(command !== "tasks" && values.has("--done"))
	)
		usageError();
	const rawLimit = values.get("--limit");
	if (
		rawLimit &&
		(!/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
			Number(rawLimit) > PUBLIC_API_MAX_PAGE_SIZE)
	)
		usageError();
	const cursor = values.get("--cursor");
	if (cursor && !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) usageError();
	const workspaceId = values.get("--workspace");
	const listId = values.get("--list");
	if (listCommand && !PUBLIC_API_ID.safeParse(listId).success) usageError();
	for (const id of [workspaceId, listId])
		if (id !== undefined && !PUBLIC_API_ID.safeParse(id).success) usageError();
	const done = values.get("--done");
	if (done !== undefined && !["true", "false"].includes(done)) usageError();
	const server = values.get("--server") ?? env.DITERO_URL;
	if (!server)
		throw new CliError("missing_server", "Set DITERO_URL or pass --server.", 2);
	const origin = canonicalServer(server, flags.has("--allow-loopback-http"));
	const token = env.DITERO_TOKEN;
	if (!token || !/^ditero_pat_[A-Za-z0-9_-]{43}$/.test(token))
		throw new CliError(
			"missing_token",
			"Set DITERO_TOKEN to a personal access token.",
			2,
		);
	return {
		command,
		server: origin,
		token,
		json: flags.has("--json"),
		all: flags.has("--all"),
		limit: rawLimit ? Number(rawLimit) : PUBLIC_API_PAGE_SIZE,
		cursor,
		workspaceId,
		listId,
		done,
		requestId,
		taskId,
		commentId,
		webhookId,
		folderId,
		revealSecret: flags.has("--reveal-secret"),
	};
}
