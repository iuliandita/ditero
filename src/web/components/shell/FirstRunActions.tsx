import { useZero } from "@rocicorp/zero/react";
import { Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListIcon } from "@/lib/list-icon";
import type { ListKind } from "../../../domain/icon-map.ts";
import { randomId } from "../../../domain/random-id.ts";
import {
	STARTER_TEMPLATES,
	type TemplateContent,
} from "../../../domain/template.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type { List, schema } from "../../../zero/schema.gen.ts";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";
import { nextKey } from "./CreateList.tsx";

// Each starter has a distinct list kind, so the kind names the starter. There
// is no project starter.
type StarterKind = Exclude<ListKind, "project">;
const STARTER_NAMES: Record<StarterKind, () => string> = {
	shopping: m.starter_name_shopping,
	checklist: m.starter_name_checklist,
	tasks: m.starter_name_tasks,
	habits: m.starter_name_habits,
};

type ListContent = Extract<TemplateContent, { kind: "list" }>;
const STARTERS = STARTER_TEMPLATES.filter(
	(c): c is ListContent & { listKind: StarterKind } =>
		c.kind === "list" && c.listKind !== "project",
);

// The welcome's one primary action plus the household starters as quick
// starts. A starter lands the user inside the new, already populated list.
export function FirstRunActions({
	workspaceId,
	lists,
	onCreateList,
	onOpenList,
}: {
	workspaceId: string;
	lists: List[];
	onCreateList: () => void;
	onOpenList: (id: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const startersId = useId();

	async function start(content: (typeof STARTERS)[number]) {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		const listId = randomId();
		try {
			await zero.mutate(
				mutators.template.instantiateContent({
					content,
					workspaceId,
					listId,
					sortKey: nextKey(lists),
					name: STARTER_NAMES[content.listKind](),
				}),
			).client;
			onOpenList(listId);
		} catch (e) {
			setError(mutationErrorMessage(e, m.create_list_failed));
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col items-center gap-5">
			<Button
				data-testid="first-run-create-list"
				size="lg"
				className="h-11 px-4"
				onClick={onCreateList}
			>
				<Plus />
				{m.view_empty_welcome_action()}
			</Button>
			<div className="flex flex-col items-center gap-2">
				<p id={startersId} className="text-sm text-muted-foreground">
					{m.view_empty_welcome_starters()}
				</p>
				<ul
					aria-labelledby={startersId}
					className="flex flex-wrap justify-center gap-2"
				>
					{STARTERS.map((content) => (
						<li key={content.listKind}>
							<Button
								data-testid={`first-run-starter-${content.listKind}`}
								variant="outline"
								className="h-11 gap-2 px-3 md:h-9"
								disabled={busy}
								onClick={() => void start(content)}
							>
								<ListIcon
									icon={content.icon ?? null}
									kind={content.listKind}
									title=""
								/>
								{STARTER_NAMES[content.listKind]()}
							</Button>
						</li>
					))}
				</ul>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
