import { useQuery, useZero } from "@rocicorp/zero/react";
import { Copy, Pencil, Send, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runMutation } from "@/lib/run-mutation";
import { deriveConnections } from "../../../domain/connections.ts";
import { parseMentions } from "../../../domain/mention.ts";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { MemberAvatar } from "./avatar.tsx";

const INVITE_ROLES = new Set(["owner", "admin", "member"]);

type Person = { name: string; userId?: string; image?: string | null };
type MentionInvite = { name: string; userId?: string };

const stampFmt = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

function firstToken(name: string): string {
	return name.trim().split(/\s+/)[0] ?? "";
}

// A parsed handle resolves to a person when it equals their first name token or
// their whitespace-stripped full name (case-insensitive). Keeps insert (`@Name`)
// and the post-send parse in sync without a rich editor.
function personMatchesHandle(name: string, handle: string): boolean {
	const h = handle.toLowerCase();
	return (
		firstToken(name).toLowerCase() === h ||
		name.replace(/\s+/g, "").toLowerCase() === h
	);
}

// The active `@token` immediately left of the caret, or null. The `@` must sit
// at the start or follow whitespace, and the token must be whitespace-free.
function activeMention(
	text: string,
	caret: number,
): { start: number; query: string } | null {
	const upto = text.slice(0, caret);
	const at = upto.lastIndexOf("@");
	if (at < 0) return null;
	const before = at === 0 ? "" : upto[at - 1];
	if (before && !/\s/.test(before)) return null;
	const query = upto.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, query };
}

export function CommentThread({
	task,
	workspaceId,
}: {
	task: Task;
	workspaceId: string;
}) {
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const [comments] = useQuery(queries.comments.mine());
	const [memberships] = useQuery(queries.memberships.mine());

	const [error, setError] = useState<string | null>(null);
	const [body, setBody] = useState("");
	const [caret, setCaret] = useState(0);
	const [editing, setEditing] = useState<string | null>(null);
	const [editBody, setEditBody] = useState("");
	const [mentionInvites, setMentionInvites] = useState<MentionInvite[] | null>(
		null,
	);
	const [invitedLinks, setInvitedLinks] = useState<
		{ name: string; link: string }[] | null
	>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const thread = useMemo(
		() =>
			comments
				.filter((c) => c.taskId === task.id)
				.slice()
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
		[comments, task.id],
	);

	const members = useMemo(
		() => memberships.filter((m) => m.workspaceId === workspaceId),
		[memberships, workspaceId],
	);
	const memberIds = useMemo(
		() => new Set(members.map((m) => m.userId)),
		[members],
	);
	const userMap = useMemo(() => {
		const map = new Map<string, { name: string; image: string | null }>();
		for (const m of memberships) {
			if (m.user && !map.has(m.userId)) {
				map.set(m.userId, { name: m.user.name, image: m.user.image ?? null });
			}
		}
		return map;
	}, [memberships]);

	const memberPeople = useMemo<Person[]>(
		() =>
			members.map((m) => ({
				name: m.user?.name ?? m.userId,
				userId: m.userId,
				image: m.user?.image,
			})),
		[members],
	);
	const connectionPeople = useMemo<Person[]>(
		() =>
			deriveConnections(memberships, me)
				.filter((id) => !memberIds.has(id))
				.map((id) => ({
					name: userMap.get(id)?.name ?? id,
					userId: id,
					image: userMap.get(id)?.image ?? null,
				})),
		[memberships, me, memberIds, userMap],
	);

	const callerRole = members.find((m) => m.userId === me)?.role ?? null;
	const canInvite = callerRole != null && INVITE_ROLES.has(callerRole);

	const mention = activeMention(body, caret);
	const suggestions = useMemo(() => {
		if (!mention) return [];
		const q = mention.query.toLowerCase();
		const ranked = [...memberPeople, ...connectionPeople].filter((p) =>
			p.name.toLowerCase().startsWith(q),
		);
		return ranked.slice(0, 6);
	}, [mention, memberPeople, connectionPeople]);

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}

	function insertMention(name: string) {
		if (!mention) return;
		const next = `${body.slice(0, mention.start)}@${name} ${body.slice(caret)}`;
		setBody(next);
		const pos = mention.start + name.length + 2;
		setCaret(pos);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(pos, pos);
			}
		});
	}

	function resolveNonMemberInvites(text: string): MentionInvite[] {
		if (!canInvite) return [];
		const out: MentionInvite[] = [];
		const seen = new Set<string>();
		for (const handle of parseMentions(text)) {
			if (memberPeople.some((p) => personMatchesHandle(p.name, handle)))
				continue;
			const conn = connectionPeople.find((p) =>
				personMatchesHandle(p.name, handle),
			);
			if (conn?.userId && !seen.has(conn.userId)) {
				seen.add(conn.userId);
				out.push({ name: conn.name, userId: conn.userId });
			}
		}
		return out;
	}

	async function submit() {
		const text = body.trim();
		if (!text || busy) return;
		setError(null);
		await run(
			zero.mutate(
				mutators.comment.add({
					id: crypto.randomUUID(),
					taskId: task.id,
					body: text,
				}),
			),
		);
		setBody("");
		setCaret(0);
		const invites = resolveNonMemberInvites(text);
		if (invites.length > 0) setMentionInvites(invites);
	}

	async function confirmMentionInvites() {
		if (!mentionInvites || busy) return;
		setBusy(true);
		setError(null);
		setCopied(null);
		const links: { name: string; link: string }[] = [];
		try {
			for (const inv of mentionInvites) {
				const res = await fetch("/api/invite/create", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						workspaceId,
						role: "member",
						attachTaskId: task.id,
						attachKind: "mention",
					}),
				});
				if (!res.ok) {
					setError(
						(await res.text()).trim() ||
							`Could not invite ${inv.name} (${res.status}).`,
					);
					return;
				}
				const data = (await res.json()) as { link: string };
				links.push({ name: inv.name, link: data.link });
			}
			setMentionInvites(null);
		} catch (e) {
			console.error(e);
			setError(e instanceof Error ? e.message : "Could not create the invite.");
		} finally {
			// Surface any links created before an early return so a partial batch is
			// still deliverable rather than lost.
			if (links.length > 0) setInvitedLinks(links);
			setBusy(false);
		}
	}

	async function copyLink(link: string) {
		try {
			await navigator.clipboard.writeText(link);
			setCopied(link);
		} catch (e) {
			console.error(e);
		}
	}

	function saveEdit(id: string) {
		const text = editBody.trim();
		if (!text) return;
		void run(zero.mutate(mutators.comment.edit({ id, body: text })));
		setEditing(null);
		setEditBody("");
	}

	return (
		<div className="flex flex-col gap-2 text-sm" data-testid="comment-thread">
			<span className="text-muted-foreground">Comments</span>

			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}

			<ul className="flex flex-col gap-3">
				{thread.map((c) => {
					const name = c.author?.name ?? c.authorId;
					const mine = c.authorId === me;
					return (
						<li key={c.id} data-testid="comment-item" className="flex gap-2">
							<MemberAvatar
								name={name}
								image={c.author?.image}
								className="size-7"
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex items-baseline gap-2">
									<span className="font-medium">{name}</span>
									{c.createdAt != null && (
										<time
											dateTime={new Date(c.createdAt).toISOString()}
											className="text-xs text-muted-foreground"
										>
											{stampFmt.format(c.createdAt)}
										</time>
									)}
									{c.editedAt != null && (
										<span className="text-xs text-muted-foreground">
											(edited)
										</span>
									)}
								</div>

								{editing === c.id ? (
									<div className="flex flex-col gap-1.5">
										<textarea
											aria-label="Edit comment"
											rows={2}
											value={editBody}
											onChange={(e) => setEditBody(e.target.value)}
											className="w-full rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:border-ring"
										/>
										<div className="flex gap-1.5">
											<Button
												size="sm"
												onClick={() => saveEdit(c.id)}
												disabled={!editBody.trim()}
											>
												Save
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setEditing(null)}
											>
												Cancel
											</Button>
										</div>
									</div>
								) : (
									<p className="whitespace-pre-wrap break-words">{c.body}</p>
								)}

								{editing !== c.id && (
									<div className="flex gap-1">
										{mine && (
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Edit comment"
												data-testid="comment-edit"
												onClick={() => {
													setEditing(c.id);
													setEditBody(c.body);
												}}
											>
												<Pencil />
											</Button>
										)}
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Delete comment"
											data-testid="comment-delete"
											onClick={() =>
												void run(
													zero.mutate(mutators.comment.delete({ id: c.id })),
												)
											}
										>
											<Trash2 />
										</Button>
									</div>
								)}
							</div>
						</li>
					);
				})}
				{thread.length === 0 && (
					<li className="text-xs text-muted-foreground">No comments yet.</li>
				)}
			</ul>

			{mentionInvites && mentionInvites.length > 0 && (
				<div
					data-testid="mention-invite-confirm"
					className="flex flex-col gap-2 rounded-md border p-2"
				>
					<p>
						Invite {mentionInvites.map((i) => i.name).join(", ")} to this
						workspace?
					</p>
					<p className="text-xs text-muted-foreground">
						They join once they accept the invite.
					</p>
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setMentionInvites(null)}
						>
							Not now
						</Button>
						<Button
							size="sm"
							data-testid="mention-invite-confirm-submit"
							disabled={busy}
							onClick={() => void confirmMentionInvites()}
						>
							Invite
						</Button>
					</div>
				</div>
			)}

			{invitedLinks && invitedLinks.length > 0 && (
				<div className="flex flex-col gap-2 rounded-md border p-2">
					<span className="text-xs text-muted-foreground">
						{invitedLinks.length > 1 ? "Invites" : "Invite"} created. Share the{" "}
						{invitedLinks.length > 1 ? "links" : "link"}; each person joins on
						accept.
					</span>
					{invitedLinks.map((l) => (
						<div
							key={l.link}
							data-testid="mention-invite-link"
							className="flex flex-col gap-1"
						>
							<span className="text-xs font-medium">{l.name}</span>
							<div className="flex items-center gap-1.5">
								<Input
									readOnly
									value={l.link}
									aria-label={`Invite link for ${l.name}`}
									onFocus={(e) => e.currentTarget.select()}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label={`Copy invite link for ${l.name}`}
									onClick={() => void copyLink(l.link)}
								>
									<Copy />
								</Button>
							</div>
							{copied === l.link && (
								<span role="status" className="text-xs text-muted-foreground">
									Copied to clipboard.
								</span>
							)}
						</div>
					))}
					<Button
						variant="ghost"
						size="sm"
						className="self-end"
						onClick={() => {
							setInvitedLinks(null);
							setCopied(null);
						}}
					>
						Done
					</Button>
				</div>
			)}

			<div className="relative flex items-end gap-1.5">
				<div className="relative flex-1">
					<textarea
						ref={textareaRef}
						aria-label="Add a comment"
						data-testid="comment-input"
						placeholder="Add a comment"
						rows={2}
						value={body}
						onChange={(e) => {
							setBody(e.target.value);
							setCaret(e.target.selectionStart ?? e.target.value.length);
						}}
						onKeyUp={(e) =>
							setCaret(e.currentTarget.selectionStart ?? body.length)
						}
						onClick={(e) =>
							setCaret(e.currentTarget.selectionStart ?? body.length)
						}
						className="w-full rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:border-ring"
					/>
					{mention && suggestions.length > 0 && (
						<ul
							data-testid="mention-suggest"
							className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
						>
							{suggestions.map((p) => (
								<li key={p.userId ?? p.name}>
									<button
										type="button"
										data-testid="mention-suggest-option"
										onClick={() => insertMention(p.name)}
										className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-start hover:bg-muted"
									>
										<MemberAvatar
											name={p.name}
											image={p.image}
											className="size-5"
										/>
										<span className="min-w-0 flex-1 truncate">{p.name}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				<Button
					size="icon"
					aria-label="Send comment"
					data-testid="comment-submit"
					disabled={!body.trim() || busy}
					onClick={() => void submit()}
				>
					<Send />
				</Button>
			</div>
		</div>
	);
}
