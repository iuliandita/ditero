import { useQuery, useZero } from "@rocicorp/zero/react";
import { Copy, Paperclip, Pencil, Send, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runMutation } from "@/lib/run-mutation";
import { deriveConnections } from "../../../domain/connections.ts";
import { parseMentions, personMatchesHandle } from "../../../domain/mention.ts";
import { randomId } from "../../../domain/random-id.ts";
import { WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { copyText } from "../../lib/clipboard.ts";
import type { WorkspaceKeyMaterial } from "../../lib/e2e/KeyringProvider.tsx";
import { uploadAttachment } from "../../lib/e2e/upload.ts";
import { formatBytes, formatList } from "../../lib/intl-format.ts";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";
import { mutationServerSucceeded } from "../../lib/pref-mutation.ts";
import {
	AttachmentDropzone,
	type AttachmentDropzoneHandle,
} from "../attachments/AttachmentDropzone.tsx";
import { AttachmentList } from "../attachments/AttachmentList.tsx";
import {
	type AttachmentProgress,
	PendingAttachmentTile,
} from "../attachments/AttachmentTile.tsx";
import { useAttachmentGate } from "../attachments/states.tsx";
import { MemberAvatar } from "./avatar.tsx";

const INVITE_ROLES = new Set(["owner", "admin", "member"]);

type Person = { name: string; userId?: string; image?: string | null };
type MentionInvite = { name: string; userId?: string };
type PendingCommentFile = {
	id: string;
	file: File;
	commentId?: string;
	controller?: AbortController;
	progress?: AttachmentProgress;
	error?: string;
};

// Built per call: a cached formatter would freeze the import-time locale. No
// timeZone pin -- a comment stamp is a real instant, read in the viewer's zone.
function formatStamp(at: number): string {
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(at);
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
	restricted = false,
}: {
	task: Task;
	workspaceId: string;
	// Restricted ("kid") callers: the entire invite-on-mention flow is disabled --
	// no connection lookup, no invite-confirm panel, no links. @names stay plain
	// text; commenting itself is unchanged. Default false leaves normal mounts as-is.
	restricted?: boolean;
}) {
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const [comments] = useQuery(queries.comments.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [attachments] = useQuery(queries.attachments.mine());
	const gate = useAttachmentGate(workspaceId);

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
	const [pendingFiles, setPendingFiles] = useState<PendingCommentFile[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const attachmentPicker = useRef<AttachmentDropzoneHandle>(null);
	const attachmentButton = useRef<HTMLButtonElement>(null);

	const thread = useMemo(
		() =>
			comments
				.filter((c) => c.taskId === task.id)
				.slice()
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
		[comments, task.id],
	);

	const members = useMemo(
		() => memberships.filter((mem) => mem.workspaceId === workspaceId),
		[memberships, workspaceId],
	);
	const memberIds = useMemo(
		() => new Set(members.map((mem) => mem.userId)),
		[members],
	);
	const userMap = useMemo(() => {
		const map = new Map<string, { name: string; image: string | null }>();
		for (const mem of memberships) {
			if (mem.user && !map.has(mem.userId)) {
				map.set(mem.userId, {
					name: mem.user.name,
					image: mem.user.image ?? null,
				});
			}
		}
		return map;
	}, [memberships]);

	const memberPeople = useMemo<Person[]>(
		() =>
			members.map((mem) => ({
				name: mem.user?.name ?? mem.userId,
				userId: mem.userId,
				image: mem.user?.image,
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

	const callerRole = members.find((mem) => mem.userId === me)?.role ?? null;
	const canInvite =
		!restricted && callerRole != null && INVITE_ROLES.has(callerRole);
	const canAttach = callerRole != null && WRITE_ROLES.has(callerRole);
	const workspaceName =
		members.find((member) => member.workspace)?.workspace?.name ??
		m.field_workspace();
	const commentIdsWithAttachments = useMemo(
		() =>
			new Set(
				attachments
					.filter((row) => row.parentKind === "comment")
					.map((row) => row.parentId),
			),
		[attachments],
	);

	const mention = activeMention(body, caret);
	const suggestions = useMemo(() => {
		if (!mention || restricted) return [];
		const q = mention.query.toLowerCase();
		const ranked = [...memberPeople, ...connectionPeople].filter((p) =>
			p.name.toLowerCase().startsWith(q),
		);
		return ranked.slice(0, 6);
	}, [mention, memberPeople, connectionPeople, restricted]);

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

	function updatePendingFile(id: string, patch: Partial<PendingCommentFile>) {
		setPendingFiles((files) =>
			files.map((file) => (file.id === id ? { ...file, ...patch } : file)),
		);
	}

	function queueFiles(files: File[]) {
		setPendingFiles((current) => [
			...current,
			...files.map((file) => ({ id: randomId(), file })),
		]);
	}

	async function uploadCommentFiles(
		files: PendingCommentFile[],
		commentId: string,
		key: WorkspaceKeyMaterial,
	) {
		for (const pending of files) {
			const controller = new AbortController();
			updatePendingFile(pending.id, {
				commentId,
				controller,
				error: undefined,
			});
			try {
				await uploadAttachment(
					{
						file: pending.file,
						workspaceId,
						parentKind: "comment",
						parentId: commentId,
						keyVersion: key.keyVersion,
						wdk: key.wdk,
					},
					{
						id: pending.id,
						signal: controller.signal,
						onProgress: (progress) =>
							updatePendingFile(pending.id, {
								progress: {
									phase:
										progress.phase === "encrypting"
											? "encrypting"
											: "uploading",
									loaded: progress.loaded,
									total: progress.total,
								},
							}),
					},
				);
				setPendingFiles((current) =>
					current.filter((file) => file.id !== pending.id),
				);
			} catch (caught) {
				if (controller.signal.aborted) continue;
				console.error("attachments: comment upload failed", caught);
				gate.reportUploadFailure(caught);
				updatePendingFile(pending.id, {
					commentId,
					error: m.attachment_error_upload_failed(),
					progress: undefined,
				});
			}
		}
	}

	async function submitWithFiles(
		text: string,
		files: PendingCommentFile[],
		key: WorkspaceKeyMaterial,
	) {
		setBusy(true);
		setError(null);
		const existingCommentId = files.find((file) => file.commentId)?.commentId;
		const commentId = existingCommentId ?? randomId();
		try {
			if (!existingCommentId) {
				const mutation = zero.mutate(
					mutators.comment.add({ id: commentId, taskId: task.id, body: text }),
				);
				await mutation.client;
				// Attachments use a direct HTTP transaction. Wait for the Zero
				// mutation's server result so reserve cannot race the parent row.
				if (!(await mutationServerSucceeded(mutation))) {
					throw new Error("comment.add did not reach the server");
				}
				setBody("");
				setCaret(0);
				setPendingFiles((current) =>
					current.map((file) =>
						files.some((candidate) => candidate.id === file.id)
							? { ...file, commentId }
							: file,
					),
				);
				const invites = resolveNonMemberInvites(text);
				if (invites.length > 0) setMentionInvites(invites);
			}
			await uploadCommentFiles(files, commentId, key);
		} catch (caught) {
			setError(mutationErrorMessage(caught, m.mutation_failed));
		} finally {
			setBusy(false);
		}
	}

	async function submit() {
		const text = body.trim();
		if ((!text && pendingFiles.length === 0) || busy) return;
		if (pendingFiles.length > 0) {
			const snapshot = [...pendingFiles];
			await gate.runWithFiles(
				snapshot.map((file) => file.file),
				(key) => submitWithFiles(text, snapshot, key),
			);
			return;
		}
		setError(null);
		await run(
			zero.mutate(
				mutators.comment.add({
					id: randomId(),
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
							m.mention_invite_failed_status({
								name: inv.name,
								status: res.status,
							}),
					);
					return;
				}
				const data = (await res.json()) as { link: string };
				links.push({ name: inv.name, link: data.link });
			}
			setMentionInvites(null);
		} catch (e) {
			setError(mutationErrorMessage(e, m.invite_create_failed));
		} finally {
			// Surface any links created before an early return so a partial batch is
			// still deliverable rather than lost.
			if (links.length > 0) setInvitedLinks(links);
			setBusy(false);
		}
	}

	async function copyLink(link: string) {
		if (await copyText(link)) setCopied(link);
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
			<span className="text-muted-foreground">{m.comments_heading()}</span>

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
											{formatStamp(c.createdAt)}
										</time>
									)}
									{c.editedAt != null && (
										<span className="text-xs text-muted-foreground">
											{m.comment_edited_marker()}
										</span>
									)}
								</div>

								{editing === c.id ? (
									<div className="flex flex-col gap-1.5">
										<textarea
											aria-label={m.comment_edit_label()}
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
												{m.comment_save()}
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setEditing(null)}
											>
												{m.comment_cancel()}
											</Button>
										</div>
									</div>
								) : (
									<p className="whitespace-pre-wrap break-words">{c.body}</p>
								)}

								{commentIdsWithAttachments.has(c.id) && (
									<AttachmentList
										workspaceId={workspaceId}
										parentKind="comment"
										parentId={c.id}
										onEmptyFocus={() => attachmentButton.current?.focus()}
									/>
								)}

								{editing !== c.id && (
									<div className="flex gap-1">
										{mine && (
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={m.comment_edit_label()}
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
											aria-label={m.comment_delete_action()}
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
					<li className="text-xs text-muted-foreground">
						{m.comments_empty()}
					</li>
				)}
			</ul>

			{mentionInvites && mentionInvites.length > 0 && (
				<div
					data-testid="mention-invite-confirm"
					className="flex flex-col gap-2 rounded-md border p-2"
				>
					<p>
						{m.mention_invite_confirm({
							names: formatList(mentionInvites.map((i) => i.name)),
						})}
					</p>
					<p className="text-xs text-muted-foreground">
						{m.mention_invite_hint()}
					</p>
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setMentionInvites(null)}
						>
							{m.mention_invite_not_now()}
						</Button>
						<Button
							size="sm"
							data-testid="mention-invite-confirm-submit"
							disabled={busy}
							onClick={() => void confirmMentionInvites()}
						>
							{m.mention_invite_submit()}
						</Button>
					</div>
				</div>
			)}

			{invitedLinks && invitedLinks.length > 0 && (
				<div className="flex flex-col gap-2 rounded-md border p-2">
					<span className="text-xs text-muted-foreground">
						{m.mention_invite_created({ count: invitedLinks.length })}
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
									aria-label={m.invite_link_for_aria({ name: l.name })}
									onFocus={(e) => e.currentTarget.select()}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label={m.invite_copy_link_for_aria({ name: l.name })}
									onClick={() => void copyLink(l.link)}
								>
									<Copy />
								</Button>
							</div>
							{copied === l.link && (
								<span role="status" className="text-xs text-muted-foreground">
									{m.copied_to_clipboard()}
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
						{m.mention_invite_done()}
					</Button>
				</div>
			)}

			<AttachmentDropzone
				ref={attachmentPicker}
				gate={gate}
				workspaceName={workspaceName}
				enabled={canAttach}
				onFilesReady={(files) => queueFiles(files)}
				showButton={false}
				compact
			>
				{pendingFiles.length > 0 && (
					<ul
						className="flex flex-col gap-2"
						data-testid="comment-pending-files"
					>
						{pendingFiles.map((pending) => (
							<PendingAttachmentTile
								key={pending.id}
								name={pending.file.name}
								size={formatBytes(pending.file.size)}
								progress={pending.progress}
								error={pending.error}
								ready={!pending.progress && !pending.error}
								onCancel={() => {
									pending.controller?.abort();
									setPendingFiles((files) =>
										files.filter((file) => file.id !== pending.id),
									);
								}}
							/>
						))}
					</ul>
				)}
				<div className="relative flex items-end gap-1.5">
					<div className="relative flex-1">
						<textarea
							ref={textareaRef}
							aria-label={m.comment_input_label()}
							data-testid="comment-input"
							placeholder={m.comment_input_label()}
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
								className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-overlay"
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
					{canAttach && (
						<Button
							ref={attachmentButton}
							type="button"
							variant="outline"
							size="icon"
							aria-label={m.attachment_add_to_comment()}
							onClick={() => attachmentPicker.current?.openPicker()}
						>
							<Paperclip />
						</Button>
					)}
					<Button
						size="icon"
						aria-label={m.comment_send_action()}
						data-testid="comment-submit"
						disabled={(!body.trim() && pendingFiles.length === 0) || busy}
						onClick={() => void submit()}
					>
						<Send />
					</Button>
				</div>
			</AttachmentDropzone>
		</div>
	);
}
