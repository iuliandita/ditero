"use client";

import { useQuery, useZero } from "@rocicorp/zero/react";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { randomId } from "../../../domain/random-id.ts";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { Label, schema } from "../../../zero/schema.gen.ts";
import {
	DEFAULT_LABEL_COLOR,
	LABEL_COLORS,
	labelColorClass,
	labelColorName,
} from "../../lib/label-color.ts";
import { NameDialog } from "../shell/NameDialog.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import { RowActions } from "../ui/row-actions.tsx";
import { labelActions } from "./labelActions.ts";

type NameTarget = { mode: "create" } | { mode: "rename"; label: Label };

/**
 * Workspace-scoped label CRUD: the only surface reaching label.update and
 * label.delete. Labels belong to a workspace, so this renders inside the active
 * workspace's settings block and never aggregates across workspaces.
 */
export function LabelManager({
	workspaceId,
	role,
}: {
	workspaceId: string;
	role: Role | null;
}) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
	const [allLabels] = useQuery(queries.labels.mine());
	const [nameTarget, setNameTarget] = useState<NameTarget | null>(null);
	const [colorTarget, setColorTarget] = useState<Label | null>(null);

	const labels = useMemo(
		() =>
			allLabels
				.filter((l) => l.workspaceId === workspaceId)
				.sort((a, b) => a.name.localeCompare(b.name)),
		[allLabels, workspaceId],
	);

	const canWrite = role !== null && WRITE_ROLES.has(role);

	// The duplicate-name rejection is detected against the synced label rows, not
	// by matching the mutator's English "label name already exists" string: the
	// client mutator re-runs that same query locally, so this is the mutator's own
	// predicate rather than a guess at its wording.
	function validateName(name: string): string | null {
		const exceptId =
			nameTarget?.mode === "rename" ? nameTarget.label.id : undefined;
		return labels.some((l) => l.name === name && l.id !== exceptId)
			? m.label_name_taken()
			: null;
	}

	function submitName(name: string) {
		const target = nameTarget;
		if (!target) return;
		const mutation =
			target.mode === "create"
				? mutators.label.create({
						id: randomId(),
						workspaceId,
						name,
						color: DEFAULT_LABEL_COLOR,
					})
				: mutators.label.update({ id: target.label.id, name });
		void zero
			.mutate(mutation)
			.client.catch((e) => console.error("label write failed", e));
	}

	function recolor(label: Label, color: string) {
		setColorTarget(null);
		void zero
			.mutate(mutators.label.update({ id: label.id, color }))
			.client.catch((e) => console.error("label.update failed", e));
	}

	async function remove(label: Label) {
		const ok = await confirm({
			title: m.label_delete_title(),
			body: m.label_delete_confirm({ name: label.name }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		// task_label rows clear through the server FK cascade only (mutators.ts
		// label.delete), so a chip can linger on a task until the next sync. That
		// is the mutator's documented behavior, not a gap here.
		void zero
			.mutate(mutators.label.delete({ id: label.id }))
			.client.catch((e) => console.error("label.delete failed", e));
	}

	const newLabelButton = (
		<Button
			size="sm"
			variant="outline"
			data-testid="label-new"
			onClick={() => setNameTarget({ mode: "create" })}
		>
			<Plus /> {m.action_new_label()}
		</Button>
	);

	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="label-manager-heading"
			data-testid="label-manager"
		>
			<div className="flex items-center justify-between gap-4">
				<h2 id="label-manager-heading" className="text-sm font-semibold">
					{m.task_field_labels()}
				</h2>
				{canWrite && labels.length > 0 && newLabelButton}
			</div>

			{labels.length === 0 ? (
				<div className="mt-4 flex flex-col items-center gap-3 py-6 text-center">
					<p className="text-xs text-muted-foreground">{m.labels_empty()}</p>
					{canWrite && newLabelButton}
				</div>
			) : (
				<ul className="mt-3 flex flex-col">
					{labels.map((label) => (
						// `group` is what reveals the kebab on desktop: RowActions is
						// opacity-0 until group-hover/group-focus-within.
						<li
							key={label.id}
							data-testid="label-row"
							className="group flex items-center gap-2 rounded-lg px-1 py-1"
						>
							<span
								aria-hidden
								className={cn(
									"size-3 shrink-0 rounded-full",
									labelColorClass(label.color),
								)}
							/>
							<span className="min-w-0 flex-1 truncate text-sm">
								{label.name}
							</span>
							<span className="text-xs text-muted-foreground">
								{labelColorName(label.color)}
							</span>
							<RowActions
								label={m.row_actions_for({ name: label.name })}
								actions={labelActions({
									label,
									role,
									handlers: {
										rename: (l) => setNameTarget({ mode: "rename", label: l }),
										recolor: setColorTarget,
										remove: (l) => void remove(l),
									},
								})}
							/>
						</li>
					))}
				</ul>
			)}

			<NameDialog
				open={nameTarget !== null}
				initialName={nameTarget?.mode === "rename" ? nameTarget.label.name : ""}
				title={
					nameTarget?.mode === "rename"
						? m.label_rename_title()
						: m.action_new_label()
				}
				fieldLabel={m.field_name()}
				testId="label-name"
				validate={validateName}
				onSubmit={submitName}
				onOpenChange={(open) => {
					if (!open) setNameTarget(null);
				}}
			/>

			<Dialog
				open={colorTarget !== null}
				onOpenChange={(open) => {
					if (!open) setColorTarget(null);
				}}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>{m.label_color_title()}</DialogTitle>
					</DialogHeader>
					<fieldset className="flex flex-wrap gap-2">
						<legend className="sr-only">{m.label_color_label()}</legend>
						{LABEL_COLORS.map((color) => (
							<button
								key={color}
								type="button"
								aria-pressed={colorTarget?.color === color}
								aria-label={labelColorName(color)}
								data-testid={`label-color-${color}`}
								className={cn(
									"size-11 rounded-lg border md:size-9",
									colorTarget?.color === color && "ring-2 ring-ring",
								)}
								onClick={() => colorTarget && recolor(colorTarget, color)}
							>
								<span
									aria-hidden
									className={cn(
										"mx-auto block size-5 rounded-full",
										labelColorClass(color),
									)}
								/>
							</button>
						))}
					</fieldset>
				</DialogContent>
			</Dialog>
		</section>
	);
}
