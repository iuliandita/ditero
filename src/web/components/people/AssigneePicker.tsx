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
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
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
		for (const m of memberships) {
			if (m.user && !map.has(m.userId)) {
				map.set(m.userId, { name: m.user.name, image: m.user.image ?? null });
			}
		}
		return map;
	}, [memberships]);

	const members = useMemo(
		() => memberships.filter((m) => m.workspaceId === workspaceId),
		[memberships, workspaceId],
	);
	const memberIds = useMemo(
		() => new Set(members.map((m) => m.userId)),
		[members],
	);
	const connectionIds = useMemo(
		() => deriveConnections(memberships, me).filter((id) => !memberIds.has(id)),
		[memberships, me, memberIds],
	);
	const callerRole = members.find((m) => m.userId === me)?.role ?? null;
	const canInvite = callerRole != null && INVITE_ROLES.has(callerRole);
	const workspaceName = members[0]?.workspace?.name ?? "this workspace";

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
		const m = assigned
			? mutators.task.unassign({ taskId: task.id, userId })
			: mutators.task.assign({ taskId: task.id, userId });
		void runMutation(zero.mutate(m), setError);
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
						`Could not create the invite (${res.status}).`,
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
			console.error(e);
			setError(e instanceof Error ? e.message : "Could not create the invite.");
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
				setError(`Lookup failed (${res.status}).`);
				setResults([]);
				return;
			}
			const found = (await res.json()) as LookupUser[];
			setResults(found.filter((u) => !memberIds.has(u.id)));
		} catch (e) {
			console.error(e);
			setError(e instanceof Error ? e.message : "Lookup failed.");
		} finally {
			setBusy(false);
		}
	}

	async function copyLink() {
		if (!invitedLink) return;
		try {
			await navigator.clipboard.writeText(invitedLink);
			setCopied(true);
		} catch (e) {
			console.error(e);
		}
	}

	const assignedCount = assignedIds.size;

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span className="text-muted-foreground">Assignees</span>
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
						{assignedCount > 0 ? `Assignees (${assignedCount})` : "Assign"}
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
									Invite {pending.name} to {workspaceName} and assign?
								</p>
								<p className="text-xs text-muted-foreground">
									They are assigned once they accept the invite.
								</p>
								<div className="flex justify-end gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setPending(null)}
									>
										Cancel
									</Button>
									<Button
										size="sm"
										data-testid="assignee-invite-confirm-submit"
										disabled={busy}
										onClick={() => void confirmInvite()}
									>
										Invite & assign
									</Button>
								</div>
							</div>
						) : invitedLink ? (
							<div className="flex flex-col gap-2 rounded-md border p-2">
								<InviteMailNotice mail={inviteMail} email={inviteMailTo} />
								<span className="text-xs text-muted-foreground">
									Invite created. Share this link; they are assigned on accept.
								</span>
								<div className="flex items-center gap-1.5">
									<Input
										readOnly
										value={invitedLink}
										aria-label="Invite link"
										data-testid="assignee-invite-link"
										onFocus={(e) => e.currentTarget.select()}
									/>
									<Button
										type="button"
										variant="outline"
										size="icon"
										aria-label="Copy invite link"
										onClick={() => void copyLink()}
									>
										<Copy />
									</Button>
								</div>
								{copied && (
									<span role="status" className="text-xs text-muted-foreground">
										Copied to clipboard.
									</span>
								)}
							</div>
						) : null}

						<section className="flex flex-col gap-0.5">
							<h4 className="px-1 text-xs font-medium text-muted-foreground">
								Members
							</h4>
							{members.map((m) => {
								const name = m.user?.name ?? m.userId;
								const assigned = assignedIds.has(m.userId);
								return (
									<button
										key={m.id}
										type="button"
										data-testid="assignee-option"
										aria-pressed={assigned}
										disabled={!canInvite}
										onClick={() => toggleMember(m.userId)}
										className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
									>
										<MemberAvatar
											name={name}
											image={m.user?.image}
											className="size-6"
										/>
										<span className="min-w-0 flex-1 truncate">
											{name}
											{m.userId === me && (
												<span className="text-muted-foreground"> (you)</span>
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
									Connections
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
												{canInvite ? "Invite" : "Ask an admin"}
											</span>
										</button>
									);
								})}
							</section>
						)}

						<section className="flex flex-col gap-1.5 border-t pt-2">
							<h4 className="px-1 text-xs font-medium text-muted-foreground">
								Find by email
							</h4>
							<div className="flex items-center gap-1.5">
								<Input
									type="email"
									placeholder="name@example.com"
									aria-label="Find someone by email"
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
									aria-label="Search"
									disabled={busy || !email.trim()}
									onClick={() => void lookup()}
								>
									<Search />
								</Button>
							</div>
							{results?.length === 0 && (
								<span className="px-1 text-xs text-muted-foreground">
									No match. An exact email is required.
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
										{canInvite ? "Invite" : "Ask an admin"}
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
