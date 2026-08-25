"use client";

import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { randomId } from "../../../domain/random-id.ts";
import type { Role } from "../../../domain/role.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Template } from "../../../zero/schema.gen.ts";
import { useConfirm } from "../ui/confirm.tsx";
import { RowActions } from "../ui/row-actions.tsx";
import { templateActions } from "./templateActions.ts";

/**
 * Workspace-scoped template list: the only surface reaching template.delete, and
 * a second entry point to template.instantiateList beside the create-list form.
 * Templates cannot be created here -- they only exist via "Save as template" on
 * a list -- so there is no new-template control and the empty state says where
 * to go instead.
 */
export function TemplateManager({
	workspaceId,
	role,
	onUsed,
}: {
	workspaceId: string;
	role: Role | null;
	/** Opens the list a "Use" just created. */
	onUsed?: (listId: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
	const [allTemplates] = useQuery(queries.templates.mine());
	const [allLists] = useQuery(queries.lists.mine());

	const templates = useMemo(
		() =>
			allTemplates
				.filter((t) => t.workspaceId === workspaceId)
				.sort((a, b) => a.name.localeCompare(b.name)),
		[allTemplates, workspaceId],
	);

	// Same placement rule as the create-list form: a template lands after the
	// workspace's current last list.
	const nextSortKey = useMemo(() => {
		const last = allLists.reduce<string | null>(
			(max, l) =>
				l.workspaceId === workspaceId && (max == null || l.sortKey > max)
					? l.sortKey
					: max,
			null,
		);
		return keyBetween(last, null);
	}, [allLists, workspaceId]);

	function instantiate(template: Template) {
		const listId = randomId();
		void zero
			.mutate(
				mutators.template.instantiateList({
					templateId: template.id,
					workspaceId,
					listId,
					sortKey: nextSortKey,
				}),
			)
			.client.then(
				() => onUsed?.(listId),
				(e) => console.error("template.instantiateList failed", e),
			);
	}

	async function remove(template: Template) {
		const ok = await confirm({
			title: m.template_delete_title(),
			body: m.template_delete_confirm({ name: template.name }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.template.delete({ id: template.id }))
			.client.catch((e) => console.error("template.delete failed", e));
	}

	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="template-manager-heading"
			data-testid="template-manager"
		>
			<h2 id="template-manager-heading" className="text-sm font-semibold">
				{m.templates_heading()}
			</h2>

			{templates.length === 0 ? (
				<p className="mt-4 py-6 text-center text-xs text-muted-foreground">
					{m.templates_empty()}
				</p>
			) : (
				<ul className="mt-3 flex flex-col">
					{templates.map((template) => (
						// `group` is what reveals the kebab on desktop: RowActions is
						// opacity-0 until group-hover/group-focus-within.
						<li
							key={template.id}
							data-testid="template-row"
							className="group flex items-center gap-2 rounded-lg px-1 py-1"
						>
							<span className="min-w-0 flex-1 truncate text-sm">
								{template.name}
							</span>
							<RowActions
								label={m.row_actions_for({ name: template.name })}
								actions={templateActions({
									template,
									role,
									userId: zero.userID ?? "",
									handlers: {
										use: instantiate,
										remove: (t) => void remove(t),
									},
								})}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
