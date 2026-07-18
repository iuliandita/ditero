import { type JSX, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useIsDesktop } from "@/lib/use-media-query";

// Assembled form output; the caller (Workspace) turns this into a
// dashboard.create or dashboard.update mutation, owning id/sortKey/panels.
export type DashboardFormValue = {
	name: string;
	icon: string | null;
	scope: "personal" | "workspace";
	workspaceId: string | null;
};

function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={htmlFor} className="text-xs font-medium">
				{label}
			</label>
			{children}
		</div>
	);
}

export function DashboardManager({
	open,
	onOpenChange,
	mode,
	initial,
	workspaces,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "create" | "edit";
	initial?: Partial<DashboardFormValue>;
	workspaces: { id: string; name: string }[];
	onSubmit: (value: DashboardFormValue) => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	const baseId = useId();
	const firstWorkspace = workspaces[0]?.id ?? null;

	const [name, setName] = useState(initial?.name ?? "");
	const [scope, setScope] = useState<"personal" | "workspace">(
		initial?.scope ?? "personal",
	);
	const [workspaceId, setWorkspaceId] = useState<string | null>(
		initial?.workspaceId ?? firstWorkspace,
	);

	// Scope is fixed at create time (dashboard.update carries no
	// scope/workspaceId), so the toggle only renders in create mode.
	const canSetScope = mode === "create";

	const trimmed = name.trim();
	const canSave =
		trimmed.length > 0 && (scope === "personal" || workspaceId != null);

	function submit() {
		if (!canSave) return;
		onSubmit({
			name: trimmed,
			icon: initial?.icon ?? null,
			scope,
			workspaceId: scope === "workspace" ? workspaceId : null,
		});
	}

	const body = (
		<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 md:px-6">
			<Field label="Name" htmlFor={`${baseId}-name`}>
				<Input
					id={`${baseId}-name`}
					data-testid="dashboard-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Dashboard name"
				/>
			</Field>

			{canSetScope && (
				<div className="grid grid-cols-2 gap-3">
					<Field label="Visibility" htmlFor={`${baseId}-scope`}>
						<Select
							value={scope}
							onValueChange={(v) =>
								setScope(v === "workspace" ? "workspace" : "personal")
							}
						>
							<SelectTrigger id={`${baseId}-scope`} size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="personal">Personal</SelectItem>
								<SelectItem value="workspace">Workspace</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					{scope === "workspace" && (
						<Field label="Shared in" htmlFor={`${baseId}-scope-ws`}>
							<Select
								value={workspaceId ?? ""}
								onValueChange={(v) => setWorkspaceId(v)}
							>
								<SelectTrigger id={`${baseId}-scope-ws`} size="sm">
									<SelectValue placeholder="Select..." />
								</SelectTrigger>
								<SelectContent>
									{workspaces.map((w) => (
										<SelectItem key={w.id} value={w.id}>
											{w.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					)}
				</div>
			)}
		</div>
	);

	const title = mode === "create" ? "New dashboard" : "Edit dashboard";
	const footer = (
		<Button
			type="button"
			data-testid="dashboard-save"
			disabled={!canSave}
			onClick={submit}
		>
			{mode === "create" ? "Create dashboard" : "Save changes"}
		</Button>
	);

	if (isDesktop) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[85dvh] max-w-lg gap-0 p-0">
					<DialogHeader className="p-4 pb-2 md:px-6">
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					{body}
					<DialogFooter className="border-t p-4 md:px-6">{footer}</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90dvh] gap-0 pb-0">
				<SheetHeader>
					<SheetTitle>{title}</SheetTitle>
				</SheetHeader>
				{body}
				<div className="border-t p-4">{footer}</div>
			</SheetContent>
		</Sheet>
	);
}
