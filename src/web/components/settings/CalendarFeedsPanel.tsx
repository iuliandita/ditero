import { useQuery } from "@rocicorp/zero/react";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import {
	CALENDAR_FEED_ACTIVE_LIMIT,
	calendarFeedCreatedSchema,
	calendarFeedCreateSchema,
	calendarFeedMetadataSchema,
	calendarFeedPath,
} from "../../../domain/public-api-calendar-feed.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import { authClient } from "../../lib/auth-client.ts";
import { copyText } from "../../lib/clipboard.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";

export type CalendarFeedMetadata = z.infer<typeof calendarFeedMetadataSchema>;
export type FeedList = { id: string; workspaceId: string; title: string };
export type FeedWorkspace = { id: string; name: string };

export function calendarFeedUrl(
	result: z.infer<typeof calendarFeedCreatedSchema>,
	selected: Pick<FeedList, "id" | "workspaceId">,
	origin: string,
): string {
	if (
		result.listId !== selected.id ||
		result.workspaceId !== selected.workspaceId ||
		result.path !== calendarFeedPath(result.secret)
	)
		throw new Error("Calendar subscription response scope mismatch");
	return new URL(result.path, origin).href;
}

class FeedRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

export async function requestCalendarFeeds<T>(
	path: string,
	schema: z.ZodType<T>,
	options: RequestInit,
): Promise<T> {
	const response = await fetch(`/api/calendar-feeds${path}`, {
		...options,
		credentials: "include",
		cache: "no-store",
	});
	if (!response.ok) {
		const problem = z
			.object({ code: z.string() })
			.safeParse(await response.json().catch(() => null));
		throw new FeedRequestError(
			problem.success
				? problem.data.code
				: response.status === 401
					? "unauthorized"
					: "request-failed",
			response.status,
		);
	}
	return z
		.object({ version: z.literal(1), data: schema, nextCursor: z.null() })
		.strict()
		.parse(await response.json()).data;
}

export function feedStatus(
	feed: CalendarFeedMetadata,
	now = Date.now(),
): "active" | "expired" | "revoked" {
	return feed.revokedAt
		? "revoked"
		: new Date(feed.expiresAt).getTime() <= now
			? "expired"
			: "active";
}

export function feedErrorMessage(failure: unknown): string {
	if (failure instanceof FeedRequestError) {
		switch (failure.code) {
			case "unauthorized":
				return m.calendar_feed_error_session();
			case "feed-limit":
				return m.calendar_feed_limit();
			case "invalid-feed-request":
				return m.calendar_feed_error_invalid();
			case "rate-limited":
			case "temporarily-unavailable":
				return m.calendar_feed_error_retry();
			case "not-found":
				return m.calendar_feed_error_missing();
		}
	}
	return m.calendar_feed_error_failed();
}

export function CalendarFeedsPanel() {
	const { data: session } = authClient.useSession();
	return session?.user.id ? (
		<FeedAccountPanel key={session.user.id} />
	) : (
		<p className="text-sm text-muted-foreground">
			{m.calendar_feed_error_session()}
		</p>
	);
}

function FeedAccountPanel() {
	const confirm = useConfirm();
	const nameId = useId();
	const listIdInput = useId();
	const [lists, listsDetails] = useQuery(queries.lists.mine());
	const [workspaces, workspacesDetails] = useQuery(queries.workspaces.mine());
	const expiryId = useId();
	const [feeds, setFeeds] = useState<CalendarFeedMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [listId, setListId] = useState("");
	const [uncertain, setUncertain] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [expiry, setExpiry] = useState("90");
	const [secret, setSecret] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const owner = useRef(0);
	const dialogOwner = useRef(0);
	const action = useRef<AbortController | null>(null);
	const locked = useRef(false);
	const creating = useRef(false);
	const scopeFailed =
		listsDetails.type === "error" || workspacesDetails.type === "error";
	const ready =
		listsDetails.type === "complete" && workspacesDetails.type === "complete";
	const visibleLists = lists.filter((list) =>
		workspaces.some((workspace) => workspace.id === list.workspaceId),
	);
	const selected = ready
		? visibleLists.find((list) => list.id === listId)
		: undefined;

	useEffect(() => {
		const timer = setTimeout(
			() => setNow(Date.now()),
			Math.min(
				60_000,
				...feeds
					.filter((feed) => feedStatus(feed, now) === "active")
					.map((feed) => Math.max(1, Date.parse(feed.expiresAt) - now)),
			),
		);
		return () => clearTimeout(timer);
	}, [feeds, now]);

	useEffect(() => {
		return () => {
			owner.current++;
			dialogOwner.current++;
			action.current?.abort();
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads feed metadata.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void requestCalendarFeeds(
			"",
			z.array(calendarFeedMetadataSchema).max(100),
			{
				signal: controller.signal,
			},
		)
			.then((rows) => {
				if (!controller.signal.aborted) setFeeds(rows);
			})
			.catch((failure) => {
				if (!controller.signal.aborted)
					setError((previous) => previous ?? feedErrorMessage(failure));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [revision]);

	function changeDialog(next: boolean) {
		const abandoned = creating.current;
		creating.current = false;
		dialogOwner.current++;
		action.current?.abort();
		action.current = null;
		locked.current = false;
		setBusy(false);
		setSecret(null);
		setCopyStatus(null);
		setError(abandoned ? m.calendar_feed_error_uncertain() : null);
		setUncertain(false);
		setName("");
		setListId("");
		setExpiry("90");
		setOpen(next);
		if (!next) setRevision((value) => value + 1);
	}

	async function create() {
		if (locked.current || uncertain || !selected || loading) return;
		const parsed = calendarFeedCreateSchema.safeParse({
			name,
			listId: selected.id,
			expiresInDays: Number(expiry),
		});
		if (!parsed.success) {
			setError(m.calendar_feed_error_invalid());
			return;
		}
		locked.current = true;
		setBusy(true);
		setError(null);
		const controller = new AbortController();
		action.current = controller;
		const epoch = dialogOwner.current;
		creating.current = true;
		const captured = { id: selected.id, workspaceId: selected.workspaceId };
		const origin = window.location.origin;
		try {
			const result = await requestCalendarFeeds("", calendarFeedCreatedSchema, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(parsed.data),
				signal: controller.signal,
			});
			if (controller.signal.aborted || epoch !== dialogOwner.current) return;
			setSecret(calendarFeedUrl(result, captured, origin));
			setRevision((value) => value + 1);
		} catch (failure) {
			if (!controller.signal.aborted && epoch === dialogOwner.current) {
				const unknown =
					!(failure instanceof FeedRequestError) || failure.status >= 500;
				setUncertain(unknown);
				setError(
					unknown
						? m.calendar_feed_error_uncertain()
						: feedErrorMessage(failure),
				);
				setRevision((value) => value + 1);
			}
		} finally {
			if (!controller.signal.aborted && epoch === dialogOwner.current) {
				creating.current = false;
				locked.current = false;
				setBusy(false);
				action.current = null;
			}
		}
	}

	async function copy() {
		if (!secret) return;
		const epoch = dialogOwner.current;
		const copied = await copyText(secret);
		if (epoch === dialogOwner.current)
			setCopyStatus(
				copied ? m.channel_copied() : m.calendar_feed_copy_failed(),
			);
	}

	async function revoke(feed: CalendarFeedMetadata) {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		const epoch = owner.current;
		const accepted = await confirm({
			title: m.calendar_feed_revoke_title({ name: feed.name }),
			body: m.calendar_feed_revoke_body(),
			confirmLabel: m.calendar_feed_revoke(),
			destructive: true,
		});
		if (epoch !== owner.current) return;
		if (!accepted) {
			locked.current = false;
			setBusy(false);
			return;
		}
		const controller = new AbortController();
		action.current = controller;
		setError(null);
		try {
			await requestCalendarFeeds(
				`/${encodeURIComponent(feed.id)}`,
				z.object({ id: z.literal(feed.id), revoked: z.literal(true) }).strict(),
				{ method: "DELETE", signal: controller.signal },
			);
			if (!controller.signal.aborted) setRevision((value) => value + 1);
		} catch (failure) {
			if (!controller.signal.aborted) setError(feedErrorMessage(failure));
		} finally {
			if (!controller.signal.aborted) {
				locked.current = false;
				setBusy(false);
				action.current = null;
			}
		}
	}

	const limitReached =
		feeds.filter((feed) => feedStatus(feed, now) === "active").length >=
		CALENDAR_FEED_ACTIVE_LIMIT;
	return (
		<div data-testid="calendar-feeds">
			<p className="max-w-prose text-sm text-muted-foreground">
				{m.calendar_feed_description()}
			</p>
			<Button
				className="mt-3 pointer-coarse:h-11"
				disabled={
					busy || loading || limitReached || !ready || visibleLists.length === 0
				}
				onClick={() => changeDialog(true)}
			>
				{m.calendar_feed_create()}
			</Button>
			{!ready || visibleLists.length === 0 ? (
				<p className="mt-2 text-sm text-muted-foreground">
					{!ready
						? scopeFailed
							? m.calendar_feed_lists_failed()
							: m.calendar_feed_lists_loading()
						: m.calendar_feed_no_lists()}
				</p>
			) : null}
			{limitReached && (
				<p className="mt-2 text-sm text-muted-foreground">
					{m.calendar_feed_limit()}
				</p>
			)}
			{loading ? (
				<p role="status" className="mt-4 text-sm">
					{m.app_loading()}
				</p>
			) : (
				feeds.length === 0 &&
				!error && (
					<p className="mt-4 text-sm text-muted-foreground">
						{m.calendar_feed_empty()}
					</p>
				)
			)}
			<CalendarFeedRows
				feeds={feeds}
				lists={visibleLists}
				workspaces={workspaces}
				now={now}
				busy={busy}
				onRevoke={(feed) => void revoke(feed)}
			/>
			{error && !open && (
				<div className="mt-3 space-y-2">
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
					<Button
						variant="outline"
						className="pointer-coarse:h-11"
						disabled={busy || loading}
						onClick={() => {
							setError(null);
							setRevision((value) => value + 1);
						}}
					>
						{m.action_retry()}
					</Button>
				</div>
			)}
			<p className="mt-3 text-xs text-muted-foreground">
				{m.calendar_feed_history()}
			</p>
			<Dialog open={open} onOpenChange={changeDialog}>
				<DialogContent
					data-testid="calendar-feed-dialog"
					onInteractOutside={(event) => {
						if (secret) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{secret
								? m.calendar_feed_secret_heading()
								: m.calendar_feed_create()}
						</DialogTitle>
						<DialogDescription>
							{secret
								? m.calendar_feed_secret_help()
								: m.calendar_feed_description()}
						</DialogDescription>
					</DialogHeader>
					{secret ? (
						<>
							<Input
								aria-label={m.calendar_feed_secret_heading()}
								value={secret}
								data-testid="calendar-feed-url"
								readOnly
								autoComplete="off"
								spellCheck={false}
								dir="ltr"
								className="font-mono"
							/>
							<Button
								className="pointer-coarse:h-11"
								onClick={() => void copy()}
							>
								{m.channel_copy()}
							</Button>
							{copyStatus && (
								<p role="status" className="text-sm">
									{copyStatus}
								</p>
							)}
							<DialogFooter>
								<Button
									variant="outline"
									className="pointer-coarse:h-11"
									onClick={() => changeDialog(false)}
								>
									{m.calendar_feed_done()}
								</Button>
							</DialogFooter>
						</>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								void create();
							}}
						>
							<div className="space-y-1.5">
								<label htmlFor={nameId}>{m.calendar_feed_name()}</label>
								<Input
									id={nameId}
									value={name}
									onChange={(event) => setName(event.target.value)}
									required
									maxLength={80}
									autoComplete="off"
									disabled={busy}
									className="pointer-coarse:h-11"
								/>
							</div>
							<div className="space-y-1.5">
								<label htmlFor={listIdInput}>{m.calendar_feed_list()}</label>
								<select
									id={listIdInput}
									value={listId}
									onChange={(event) => setListId(event.target.value)}
									disabled={busy || !ready}
									className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base md:text-sm dark:bg-input/30 pointer-coarse:h-11"
									required
								>
									<option value="">{m.calendar_feed_choose_list()}</option>
									{workspaces.map((workspace) => (
										<optgroup key={workspace.id} label={workspace.name}>
											{visibleLists
												.filter((list) => list.workspaceId === workspace.id)
												.map((list) => (
													<option key={list.id} value={list.id}>
														{list.title}
													</option>
												))}
										</optgroup>
									))}
								</select>
								{!ready ? (
									<p role="status" className="text-sm text-muted-foreground">
										{scopeFailed
											? m.calendar_feed_lists_failed()
											: m.calendar_feed_lists_loading()}
									</p>
								) : !selected && listId ? (
									<p role="alert" className="text-sm text-destructive">
										{m.calendar_feed_error_missing()}
									</p>
								) : null}
							</div>
							<div className="space-y-1.5">
								<label htmlFor={expiryId}>{m.calendar_feed_expiry()}</label>
								<Input
									id={expiryId}
									type="number"
									min={1}
									max={365}
									step={1}
									required
									value={expiry}
									onChange={(event) => setExpiry(event.target.value)}
									disabled={busy}
									className="pointer-coarse:h-11"
								/>
							</div>
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
							<DialogFooter>
								<Button
									type="submit"
									className="pointer-coarse:h-11"
									disabled={
										busy ||
										loading ||
										limitReached ||
										uncertain ||
										!selected ||
										!calendarFeedCreateSchema.safeParse({
											name,
											listId,
											expiresInDays: Number(expiry),
										}).success
									}
								>
									{m.calendar_feed_create()}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function CalendarFeedRows({
	feeds,
	lists,
	workspaces,
	now,
	busy,
	onRevoke,
}: {
	feeds: CalendarFeedMetadata[];
	lists: readonly FeedList[];
	workspaces: readonly FeedWorkspace[];
	now: number;
	busy: boolean;
	onRevoke: (feed: CalendarFeedMetadata) => void;
}) {
	const date = (value: string) =>
		new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(
			new Date(value),
		);
	return (
		<ul className="mt-4 divide-y">
			{feeds.map((feed) => {
				const status = feedStatus(feed, now);
				const list = lists.find(
					(row) =>
						row.id === feed.listId && row.workspaceId === feed.workspaceId,
				);
				const workspace = workspaces.find((row) => row.id === feed.workspaceId);
				return (
					<li
						key={feed.id}
						className="flex flex-wrap items-start justify-between gap-3 py-3"
					>
						<div className="min-w-0">
							<p className="break-words text-sm font-medium">{feed.name}</p>
							<p className="text-sm text-muted-foreground">
								{list && workspace ? (
									<>
										<bdi>{workspace.name}</bdi> / <bdi>{list.title}</bdi>
									</>
								) : (
									m.calendar_feed_list_unavailable()
								)}{" "}
								· <span dir="ltr">…{feed.hint}</span> ·{" "}
								{status === "active"
									? m.calendar_feed_active()
									: status === "expired"
										? m.calendar_feed_expired()
										: m.calendar_feed_revoked()}
							</p>
							<p className="text-xs text-muted-foreground">
								{m.calendar_feed_created({ date: date(feed.createdAt) })} ·{" "}
								{m.calendar_feed_expires({ date: date(feed.expiresAt) })}
							</p>
						</div>
						{!feed.revokedAt && (
							<Button
								variant="outline"
								className="pointer-coarse:min-h-11"
								disabled={busy}
								onClick={() => onRevoke(feed)}
								aria-label={`${m.calendar_feed_revoke()} ${feed.name}`}
							>
								{m.calendar_feed_revoke()}
							</Button>
						)}
					</li>
				);
			})}
		</ul>
	);
}
