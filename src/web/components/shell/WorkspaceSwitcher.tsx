import { ChevronsUpDown, Settings, User, Users } from "lucide-react";
import { useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { Workspace } from "../../../zero/schema.gen.ts";

type Props = {
	workspaces: Workspace[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onManageMembers: () => void;
	// Membership admin only where it can do something: any shared workspace,
	// and a personal one only while it still holds legacy members to remove.
	// Otherwise a personal workspace has no one to manage and no invite path,
	// so the switcher says so instead.
	canManageMembers: boolean;
	onOpenSettings: () => void;
};

function initial(name: string): string {
	return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function kindLabel(w: Workspace): string {
	return w.kind === "shared"
		? m.workspace_kind_shared()
		: m.workspace_kind_personal();
}

function KindIcon({ workspace }: { workspace: Workspace }) {
	const Icon = workspace.kind === "shared" ? Users : User;
	return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

// The trigger's accessible name is the workspace name itself: it says where you
// are, and the popup semantics (aria-haspopup) say it switches.
function TriggerFace({
	name,
	collapsed,
}: {
	name: string;
	collapsed?: boolean;
}) {
	return (
		<>
			<span
				aria-hidden
				className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground"
			>
				{initial(name)}
			</span>
			<span className={cn("min-w-0 flex-1 truncate", collapsed && "sr-only")}>
				{name}
			</span>
			{!collapsed && (
				<ChevronsUpDown
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
				/>
			)}
		</>
	);
}

// "Shared workspaces appear here once someone invites you" is only true while
// none is listed yet.
export function privateNoteVisible(
	workspaces: Pick<Workspace, "kind">[],
	canManageMembers: boolean,
): boolean {
	return !canManageMembers && !workspaces.some((w) => w.kind === "shared");
}

export function WorkspaceSwitcherMenu({
	workspaces,
	activeId,
	onSelect,
	onManageMembers,
	canManageMembers,
	onOpenSettings,
	collapsed,
}: Props & { collapsed?: boolean }) {
	const active = workspaces.find((w) => w.id === activeId);
	const name = active?.name ?? m.workspace_name_fallback();
	const membersPending = useRef(false);
	const showPrivateNote = privateNoteVisible(workspaces, canManageMembers);
	return (
		// modal={false}: a modal Radix menu aria-hides the app root while its
		// trigger stays focusable, which axe scores as aria-hidden-focus.
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					data-testid="workspace-switcher"
					data-workspace-id={active?.id}
					title={collapsed ? name : undefined}
					className={cn(
						"flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-start text-sm font-medium transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-sidebar-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none data-[state=open]:bg-sidebar-accent/60",
						collapsed && "justify-center px-0",
					)}
				>
					<TriggerFace name={name} collapsed={collapsed} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side={collapsed ? "right" : "bottom"}
				className="min-w-64"
				onCloseAutoFocus={(event) => {
					if (!membersPending.current) return;
					// Open the members sheet after the menu hands focus back, or
					// the restore lands on the trigger behind the sheet.
					event.preventDefault();
					membersPending.current = false;
					onManageMembers();
				}}
			>
				<DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
					{m.workspace_switcher_title()}
				</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={activeId ?? ""}
					onValueChange={(id) => {
						if (id !== activeId) onSelect(id);
					}}
				>
					{workspaces.map((w) => (
						<DropdownMenuRadioItem
							key={w.id}
							value={w.id}
							data-testid="workspace-option"
							data-workspace-kind={w.kind}
							className="min-h-9 gap-2"
						>
							<KindIcon workspace={w} />
							<span className="flex min-w-0 flex-col">
								<span className="truncate">{w.name}</span>
								<span className="text-xs text-muted-foreground">
									{kindLabel(w)}
								</span>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				{canManageMembers && (
					<DropdownMenuItem
						data-testid="manage-members"
						className="min-h-9"
						onSelect={() => {
							membersPending.current = true;
						}}
					>
						<Users />
						{m.workspace_manage_members()}
					</DropdownMenuItem>
				)}
				{showPrivateNote && (
					<p
						data-testid="workspace-private-note"
						className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground"
					>
						{m.workspace_private_note()}
					</p>
				)}
				<DropdownMenuItem
					data-testid="switcher-settings"
					className="min-h-9"
					onSelect={onOpenSettings}
				>
					<Settings />
					{m.nav_settings()}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// Touch variant: a bottom sheet (thumb reach, 44px rows) with the same entries
// and test ids as the desktop menu.
export function WorkspaceSwitcherSheet({
	workspaces,
	activeId,
	onSelect,
	onManageMembers,
	canManageMembers,
	onOpenSettings,
}: Props) {
	const [open, setOpen] = useState(false);
	const showPrivateNote = privateNoteVisible(workspaces, canManageMembers);
	const active = workspaces.find((w) => w.id === activeId);
	const name = active?.name ?? m.workspace_name_fallback();
	// Both follow-ups replace the header this sheet's trigger lives in, so they
	// run after the sheet has closed and released focus, never in the same tick.
	const pending = useRef<(() => void) | null>(null);
	const closeThen = (action: () => void) => {
		pending.current = action;
		setOpen(false);
	};
	const row =
		"flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted active:bg-muted motion-reduce:transition-none";
	return (
		<>
			<button
				type="button"
				data-testid="workspace-switcher"
				data-workspace-id={active?.id}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(true)}
				className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-lg px-2 text-start text-base font-semibold active:bg-muted"
			>
				<TriggerFace name={name} />
			</button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side="bottom"
					className="max-h-[85dvh]"
					onCloseAutoFocus={(event) => {
						const action = pending.current;
						if (!action) return;
						event.preventDefault();
						pending.current = null;
						action();
					}}
				>
					<SheetHeader>
						<SheetTitle>{m.workspace_switcher_title()}</SheetTitle>
					</SheetHeader>
					<div className="flex flex-col gap-1 overflow-y-auto px-2 pb-4">
						{workspaces.map((w) => (
							<button
								key={w.id}
								type="button"
								data-testid="workspace-option"
								data-workspace-kind={w.kind}
								aria-current={w.id === activeId ? "true" : undefined}
								onClick={() => {
									setOpen(false);
									if (w.id !== activeId) onSelect(w.id);
								}}
								className={cn(row, w.id === activeId && "bg-muted font-medium")}
							>
								<KindIcon workspace={w} />
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{w.name}</span>
									<span className="text-xs font-normal text-muted-foreground">
										{kindLabel(w)}
									</span>
								</span>
							</button>
						))}
						<div className="my-1 h-px bg-border" />
						{canManageMembers && (
							<button
								type="button"
								data-testid="manage-members"
								onClick={() => closeThen(onManageMembers)}
								className={row}
							>
								<Users aria-hidden className="size-4 shrink-0" />
								{m.workspace_manage_members()}
							</button>
						)}
						{showPrivateNote && (
							<p
								data-testid="workspace-private-note"
								className="px-3 py-2 text-sm text-muted-foreground"
							>
								{m.workspace_private_note()}
							</p>
						)}
						<button
							type="button"
							data-testid="switcher-settings"
							onClick={() => closeThen(onOpenSettings)}
							className={row}
						>
							<Settings aria-hidden className="size-4 shrink-0" />
							{m.nav_settings()}
						</button>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
