import { useQuery, useZero } from "@rocicorp/zero/react";
import { Baby, Copy, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useIsDesktop } from "@/lib/use-media-query";
import type { Role } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { runMutation } from "../../lib/run-mutation.ts";
import { AddKid } from "./AddKid.tsx";
import { InviteDialog } from "./InviteDialog.tsx";
import { ROLE_LABELS } from "./role-labels.ts";

const ROLE_BADGE: Record<Role, "default" | "secondary" | "outline"> = {
	owner: "default",
	admin: "secondary",
	member: "outline",
	viewer: "outline",
};

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MembersPanel({
	workspaceId,
	workspaceName,
	open,
	onOpenChange,
}: {
	workspaceId: string;
	workspaceName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isDesktop = useIsDesktop();
	const zero = useZero<typeof schema>();
	const [memberships] = useQuery(queries.memberships.mine());
	const [invites] = useQuery(queries.invites.forWorkspace());
	const [error, setError] = useState<string | null>(null);
	const [inviteOpen, setInviteOpen] = useState(false);
	const [addKidOpen, setAddKidOpen] = useState(false);
	// Links for invites minted this session. The token (and therefore the link)
	// is never synced, so an invite arriving via Zero sync has no copyable link --
	// only the row is available and we can offer Revoke. This map is the one place
	// the freshly created link survives long enough for the row to be copyable.
	const [createdLinks, setCreatedLinks] = useState<Record<string, string>>({});
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const members = useMemo(
		() => memberships.filter((mem) => mem.workspaceId === workspaceId),
		[memberships, workspaceId],
	);
	const pending = useMemo(
		() => invites.filter((inv) => inv.workspaceId === workspaceId),
		[invites, workspaceId],
	);
	const callerRole = useMemo(
		() =>
			(members.find((mem) => mem.userId === zero.userID)?.role as
				| Role
				| undefined) ?? null,
		[members, zero.userID],
	);
	const canInvite =
		callerRole === "owner" || callerRole === "admin" || callerRole === "member";

	async function revoke(id: string) {
		await runMutation(zero.mutate(mutators.invite.revoke({ id })), setError);
	}
	async function copy(id: string, link: string) {
		try {
			await navigator.clipboard.writeText(link);
			setCopiedId(id);
		} catch (e) {
			console.error(e);
		}
	}

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side={isDesktop ? "right" : "bottom"}
					data-testid="members-panel"
					className={isDesktop ? undefined : "max-h-[85dvh]"}
				>
					<SheetHeader>
						<SheetTitle>{m.members_heading()}</SheetTitle>
						<SheetDescription>{workspaceName}</SheetDescription>
					</SheetHeader>

					<div className="flex flex-col gap-5 overflow-y-auto px-4">
						<section className="flex flex-col gap-2">
							<h3 className="text-xs font-medium text-muted-foreground">
								{m.members_heading()}
							</h3>
							<ul className="flex flex-col gap-1">
								{members.map((mem) => {
									const name = mem.user?.name ?? mem.userId;
									const role = (mem.role as Role) ?? "member";
									return (
										<li
											key={mem.id}
											className="flex items-center gap-3 rounded-lg border p-2"
										>
											<span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
												{mem.user?.image ? (
													<img
														src={mem.user.image}
														alt=""
														className="size-full object-cover"
													/>
												) : (
													initials(name)
												)}
											</span>
											<span className="min-w-0 flex-1 truncate text-sm">
												{name}
												{mem.userId === zero.userID && (
													<span className="text-muted-foreground">
														{" "}
														{m.person_you_suffix()}
													</span>
												)}
											</span>
											<Badge variant={ROLE_BADGE[role]}>
												{ROLE_LABELS[role]()}
											</Badge>
										</li>
									);
								})}
							</ul>
						</section>

						{/* Pending invites only sync for owners/admins (queries.ts admin
						    gate); the section is simply empty for other roles. */}
						{pending.length > 0 && (
							<section className="flex flex-col gap-2">
								<h3 className="text-xs font-medium text-muted-foreground">
									{m.members_pending_heading()}
								</h3>
								<ul className="flex flex-col gap-1">
									{pending.map((inv) => {
										const link = createdLinks[inv.id];
										return (
											<li
												key={inv.id}
												className="flex items-center gap-2 rounded-lg border p-2"
											>
												<span className="min-w-0 flex-1 truncate text-sm">
													{inv.email ?? m.invite_link_entry_fallback()}
												</span>
												{link && (
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={m.invite_copy_link_aria()}
														onClick={() => void copy(inv.id, link)}
													>
														<Copy />
													</Button>
												)}
												<Button
													type="button"
													variant="destructive"
													size="sm"
													data-testid="invite-revoke"
													onClick={() => void revoke(inv.id)}
												>
													{m.invite_revoke()}
												</Button>
											</li>
										);
									})}
								</ul>
								{copiedId && (
									<span role="status" className="text-xs text-muted-foreground">
										{m.copied_to_clipboard()}
									</span>
								)}
							</section>
						)}

						{error && (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						)}
					</div>

					{canInvite && callerRole && (
						<SheetFooter>
							<Button
								type="button"
								data-testid="invite-open"
								onClick={() => setInviteOpen(true)}
							>
								<UserPlus />
								{m.invite_people_action()}
							</Button>
							<Button
								type="button"
								variant="outline"
								data-testid="add-kid-open"
								onClick={() => setAddKidOpen(true)}
							>
								<Baby />
								{m.add_kid_action()}
							</Button>
						</SheetFooter>
					)}
				</SheetContent>
			</Sheet>

			{canInvite && callerRole && (
				<InviteDialog
					workspaceId={workspaceId}
					callerRole={callerRole}
					open={inviteOpen}
					onOpenChange={setInviteOpen}
					onCreated={({ id, link }) =>
						setCreatedLinks((links) => ({ ...links, [id]: link }))
					}
				/>
			)}

			{canInvite && callerRole && (
				<AddKid
					workspaceId={workspaceId}
					open={addKidOpen}
					onOpenChange={setAddKidOpen}
				/>
			)}
		</>
	);
}
