import { useQuery, useZero } from "@rocicorp/zero/react";
import { Check, Copy, Search, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { runMutation } from "@/lib/run-mutation";
import { deriveConnections } from "../../../domain/connections.ts";
import type { InviteMailStatus } from "../../../domain/invite.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { copyText } from "../../lib/clipboard.ts";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";
import { MemberAvatar } from "./avatar.tsx";
import { InviteMailNotice } from "./InviteMailNotice";

type LookupUser = { id: string; name: string; image: string | null };
type Pending = { name: string; userId?: string; email?: string };

const INVITE_ROLES = new Set(["owner", "admin", "member"]);

// Multi-select assignee picker (design 3). Members toggle on/off via the
// assign/unassign mutators. A non-member (a connection outside this workspace,
// or someone found by email) is never silently granted: selecting one raises an
// explicit "invite & assign" confirm that POSTs an invite carrying the pending
// assignment, which attaches when they accept. The invite affordance is role-
// gated to member+ (mirrors MembersPanel.canInvite); lower roles see a hint.
export function AssigneePicker({
	task,
	workspaceId,
}: {
	task: Task;
	workspaceId: string;
}) {
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const [memberships] = useQuery(queries.memberships.mine());
	const [assignees] = useQuery(queries.assignees.mine());

	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [invitedLink, setInvitedLink] = useState<string | null>(null);
	const [inviteMail, setInviteMail] = useState<InviteMailStatus | undefined>(
		undefined,
	);
	const [inviteMailTo, setInviteMailTo] = useState("");
	const [copied, setCopied] = useState(false);
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [results, setResults] = useState<LookupUser[] | null>(null);

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

	const members = useMemo(
		() => memberships.filter((mem) => mem.workspaceId === workspaceId),
		[memberships, workspaceId],
	);
	const memberIds = useMemo(
		() => new Set(members.map((mem) => mem.userId)),
		[members],
	);
	const connectionIds = useMemo(
		() => deriveConnections(memberships, me).filter((id) => !memberIds.has(id)),
		[memberships, me, memberIds],
	);
	const callerRole = members.find((mem) => mem.userId === me)?.role ?? null;
	const canInvite = callerRole != null && INVITE_ROLES.has(callerRole);
	const workspaceName = members[0]?.workspace?.name ?? null;

	const assignedIds = useMemo(
		() =>
			new Set(
				assignees.filter((a) => a.taskId === task.id).map((a) => a.userId),
			),
		[assignees, task.id],
	);

	function toggleMember(userId: string) {
		setError(null);
		const assigned = assignedIds.has(userId);
		const mutation = assigned
			? mutators.task.unassign({ taskId: task.id, userId })
			: mutators.task.assign({ taskId: task.id, userId });
		void runMutation(zero.mutate(mutation), setError);
	}

	function requestInvite(p: Pending) {
		setInvitedLink(null);
		setInviteMail(undefined);
		setInviteMailTo("");
		setCopied(false);
		setPending(p);
	}

	async function confirmInvite() {
		if (!pending || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/invite/create", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceId,
					role: "member",
					attachTaskId: task.id,
					attachKind: "assign",
					...(pending.email ? { email: pending.email } : {}),
				}),
			});
			if (!res.ok) {
				setError(
					(await res.text()).trim() ||
						m.invite_create_failed_status({ status: res.status }),
				);
				return;
			}
			const data = (await res.json()) as {
				link: string;
				mail?: InviteMailStatus;
			};
			setInviteMail(data.mail);
			setInviteMailTo(pending.email ?? "");
			setInvitedLink(data.link);
			setPending(null);
		} catch (e) {
			setError(mutationErrorMessage(e, m.invite_create_failed));
		} finally {
			setBusy(false);
		}
	}

	async function lookup() {
		const q = email.trim();
		if (!q || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(
				`/api/users/lookup?email=${encodeURIComponent(q)}`,
				{ credentials: "include" },
			);
			if (!res.ok) {
				setError(m.assignee_lookup_failed_status({ status: res.status }));
				setResults([]);
				return;
			}
			const found = (await res.json()) as LookupUser[];
			setResults(found.filter((u) => !memberIds.has(u.id)));
		} catch (e) {
			setError(mutationErrorMessage(e, m.assignee_lookup_failed));
		} finally {
			setBusy(false);
		}
	}

	async function copyLink() {
		if (!invitedLink) return;
		if (await copyText(invitedLink)) setCopied(true);
	}

	const assignedCount = assignedIds.size;

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span className="text-muted-foreground">{m.field_assignees()}</span>
			<Popover
				onOpenChange={(o) => {
					if (!o) {
						setPending(null);
						setResults(null);
						setEmail("");
						setInvitedLink(null);
						setError(null);
					}
				}}
			>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						data-testid="assignee-open"
					>
						<UserPlus />
						{assignedCount > 0
							? m.assignee_open_count({ count: assignedCount })
							: m.assignee_open()}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-72"
					data-testid="assignee-picker"
				>
					<div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
						{error && (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						)}

						{pending ? (
							<div
								data-testid="assignee-invite-confirm"
								className="flex flex-col gap-2 rounded-md border p-2"
							>
								<p>
									{workspaceName
										? m.assignee_invite_confirm({
												name: pending.name,
												workspace: workspaceName,
											})
										: m.assignee_invite_confirm_no_workspace({
												name: pending.name,
											})}
								</p>
								<p className="text-xs text-muted-foreground">
									{m.assignee_invite_hint()}
								</p>
								<div className="flex justify-end gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setPending(null)}
									>
										{m.assignee_invite_cancel()}
									</Button>
									<Button
										size="sm"
										data-testid="assignee-invite-confirm-submit"
										disabled={busy}
										onClick={() => void confirmInvite()}
									>
										{m.assignee_invite_submit()}
									</Button>
								</div>
							</div>
						) : invitedLink ? (
							<div className="flex flex-col gap-2 rounded-md border p-2">
								<InviteMailNotice mail={inviteMail} email={inviteMailTo} />
								<span className="text-xs text-muted-foreground">
									{m.assignee_invite_created()}
								</span>
								<div className="flex items-center gap-1.5">
									<Input
										readOnly
										value={invitedLink}
										aria-label={m.invite_link_aria()}
										data-testid="assignee-invite-link"
										onFocus={(e) => e.currentTarget.select()}
									/>
									<Button
										type="button"
										variant="outline"
										size="icon"
										aria-label={m.invite_copy_link_aria()}
										onClick={() => void copyLink()}
									>
										<Copy />
									</Button>
								</div>
								{copied && (
									<span role="status" className="text-xs text-muted-foreground">
										{m.copied_to_clipboard()}
									</span>
								)}
							</div>
						) : null}

						<section className="flex flex-col gap-0.5">
							<h4 className="px-1 text-xs font-medium text-muted-foreground">
								{m.members_heading()}
							</h4>
							{members.map((mem) => {
								const name = mem.user?.name ?? mem.userId;
								const assigned = assignedIds.has(mem.userId);
								return (
									<button
										key={mem.id}
										type="button"
										data-testid="assignee-option"
										aria-pressed={assigned}
										disabled={!canInvite}
										onClick={() => toggleMember(mem.userId)}
										className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
									>
										<MemberAvatar
											name={name}
											image={mem.user?.image}
											className="size-6"
										/>
										<span className="min-w-0 flex-1 truncate">
											{name}
											{mem.userId === me && (
												<span className="text-muted-foreground">
													{" "}
													{m.person_you_suffix()}
												</span>
											)}
										</span>
										<span className="flex size-4 items-center justify-center">
											{assigned && <Check className="size-3.5" />}
										</span>
									</button>
								);
							})}
						</section>

						{connectionIds.length > 0 && (
							<section className="flex flex-col gap-0.5">
								<h4 className="px-1 text-xs font-medium text-muted-foreground">
									{m.connections_section_heading()}
								</h4>
								{connectionIds.map((userId) => {
									const u = userMap.get(userId);
									const name = u?.name ?? userId;
									return (
										<button
											key={userId}
											type="button"
											data-testid="assignee-option"
											disabled={!canInvite}
											onClick={() => requestInvite({ name, userId })}
											className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
										>
											<MemberAvatar
												name={name}
												image={u?.image}
												className="size-6"
											/>
											<span className="min-w-0 flex-1 truncate">{name}</span>
											<span className="text-xs text-muted-foreground">
												{canInvite
													? m.assignee_row_invite()
													: m.assignee_row_ask_admin()}
											</span>
										</button>
									);
								})}
							</section>
						)}

						<section className="flex flex-col gap-1.5 border-t pt-2">
							<h4 className="px-1 text-xs font-medium text-muted-foreground">
								{m.assignee_find_by_email_heading()}
							</h4>
							<div className="flex items-center gap-1.5">
								<Input
									type="email"
									placeholder={m.email_placeholder()}
									aria-label={m.assignee_find_by_email_aria()}
									data-testid="assignee-email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void lookup();
									}}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label={m.assignee_search_action()}
									disabled={busy || !email.trim()}
									onClick={() => void lookup()}
								>
									<Search />
								</Button>
							</div>
							{results?.length === 0 && (
								<span className="px-1 text-xs text-muted-foreground">
									{m.assignee_no_match()}
								</span>
							)}
							{results?.map((u) => (
								<button
									key={u.id}
									type="button"
									data-testid="assignee-option"
									disabled={!canInvite}
									onClick={() =>
										requestInvite({ name: u.name, email: email.trim() })
									}
									className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
								>
									<MemberAvatar
										name={u.name}
										image={u.image}
										className="size-6"
									/>
									<span className="min-w-0 flex-1 truncate">{u.name}</span>
									<span className="text-xs text-muted-foreground">
										{canInvite
											? m.assignee_row_invite()
											: m.assignee_row_ask_admin()}
									</span>
								</button>
							))}
						</section>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
