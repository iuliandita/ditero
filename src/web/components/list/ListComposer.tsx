import { useZero } from "@rocicorp/zero/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { addCopyFor } from "@/lib/kind-copy";
import type { ListKind } from "../../../domain/icon-map.ts";
import {
	normalizeListName,
	parseLeadingAmount,
	parseQuickAdd,
	type QuickAddToken,
} from "../../../domain/quick-add.ts";
import { randomId } from "../../../domain/random-id.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import type { TitleCandidate } from "../../../domain/title-suggest.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { mutators } from "../../../zero/mutators.ts";
import type { Label, List, schema, Task } from "../../../zero/schema.gen.ts";
import { TokenChips } from "../quickadd/TokenChips.tsx";
import { TitleSuggestInput } from "./TitleSuggestInput.tsx";

const READ_ONLY_ID = "list-read-only";
const REASON_ID = "list-composer-reason";

// The in-list add field. Tasks, projects and checklists read the quick-add
// grammar; shopping reads only a leading amount; habits stay literal. A chip
// is a reading of the text, never a rewrite of it: the words stay in the field
// until the user removes them, and a chip can always go back to plain words.
export function ListComposer({
	list,
	kind,
	lists,
	tasks,
	labels,
	canAttach,
	isDesktop,
	inputRef,
	candidates,
	run,
}: {
	list: List;
	kind: ListKind;
	lists: List[];
	tasks: Task[];
	labels: Label[];
	canAttach: boolean;
	isDesktop: boolean;
	inputRef: React.RefObject<HTMLInputElement | null>;
	candidates: readonly TitleCandidate[];
	run: (mutation: { client: Promise<unknown> }) => Promise<boolean>;
}) {
	const zero = useZero<typeof schema>();
	const addCopy = addCopyFor(kind);
	const [text, setText] = useState("");
	// Lowercased token texts the user turned back into plain words.
	const [literal, setLiteral] = useState<string[]>([]);
	const [added, setAdded] = useState<{ list: string; id: string } | null>(null);
	const mode =
		kind === "shopping" ? "amount" : kind === "habits" ? "text" : "quick";

	const workspaceLists = useMemo(
		() => lists.filter((l) => l.workspaceId === list.workspaceId),
		[lists, list.workspaceId],
	);
	const locale = getLocale();
	const quick = useMemo(() => {
		if (mode !== "quick") return null;
		const parsed = parseQuickAdd(
			text,
			undefined,
			locale,
			workspaceLists.map((l) => l.title),
			literal,
		);
		// Nothing left to name the task: save the words as typed instead.
		return parsed.title ? parsed : null;
	}, [mode, text, locale, workspaceLists, literal]);
	const amount = useMemo(() => {
		if (mode !== "amount") return null;
		const parsed = parseLeadingAmount(text);
		return parsed && !literal.includes(parsed.token.text.toLowerCase())
			? parsed
			: null;
	}, [mode, text, literal]);

	const listToken = quick?.tokens.find((t) => t.type === "list");
	const matches = quick?.listName
		? workspaceLists.filter(
				(l) =>
					normalizeListName(l.title) ===
					normalizeListName(quick.listName ?? ""),
			)
		: [];
	// A name shared by several lists in this workspace means the open one when
	// it is among them; otherwise the choice is the user's.
	const target = !listToken
		? list
		: matches.length === 1
			? matches[0]
			: (matches.find((l) => l.id === list.id) ?? null);
	const listProblem = listToken != null && target == null;
	const problemText = listProblem
		? matches.length > 1
			? m.quickadd_choose_list()
			: m.quickadd_list_not_found({ list: quick?.listName ?? "" })
		: null;

	const workspaceLabels = labels.filter(
		(l) => l.workspaceId === list.workspaceId,
	);
	const unknownLabels = new Set(
		(quick?.labels ?? [])
			.filter(
				(n) =>
					!workspaceLabels.some(
						(l) => l.name.toLowerCase() === n.toLowerCase(),
					),
			)
			.map((n) => n.toLowerCase()),
	);
	const chips: QuickAddToken[] = quick
		? quick.tokens.filter((t) => t.type !== "list" || !listProblem)
		: amount
			? [amount.token]
			: [];

	useEffect(() => {
		if (!added) return;
		const timer = setTimeout(() => setAdded(null), 4000);
		return () => clearTimeout(timer);
	}, [added]);

	function change(next: string) {
		setText(next);
		setAdded(null);
		const lower = next.toLowerCase();
		setLiteral((prev) => {
			const kept = prev.filter((token) => lower.includes(token));
			return kept.length === prev.length ? prev : kept;
		});
	}

	function keepAsText(token: QuickAddToken) {
		setLiteral((prev) => [...prev, token.text.toLowerCase()]);
		inputRef.current?.focus();
	}

	// One Backspace right after a chip's words gives the words back instead of
	// deleting a letter of them.
	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (event.key !== "Backspace" || event.nativeEvent.isComposing) return;
		const { selectionStart, selectionEnd } = event.currentTarget;
		if (selectionStart !== selectionEnd) return;
		const token = chips.find((t) => t.end === selectionStart);
		if (!token) return;
		event.preventDefault();
		keepAsText(token);
	}

	async function create() {
		const raw = text.trim();
		if (!raw || !canAttach || listProblem || !target) return;
		const title = quick?.title ?? amount?.title ?? raw;
		const lastKey = tasks
			.filter((t) => t.listId === target.id && t.parentId == null)
			.reduce<string | null>(
				(max, t) => (max == null || t.sortKey > max ? t.sortKey : max),
				null,
			);
		const id = randomId();
		setText("");
		setLiteral([]);
		const created = await run(
			zero.mutate(
				mutators.task.create({
					id,
					listId: target.id,
					title,
					sortKey: keyBetween(lastKey, null),
					...(quick?.dueAt
						? { dueAt: quick.dueAt.getTime(), dueAllDay: quick.dueAllDay }
						: {}),
					...(quick?.priority ? { priority: quick.priority } : {}),
					...(amount
						? {
								quantity: amount.quantity,
								...(amount.unit ? { unit: amount.unit } : {}),
							}
						: {}),
				}),
			),
		);
		if (!created) return;
		const labelIds: string[] = [];
		for (const name of new Set(quick?.labels.map((n) => n.toLowerCase()))) {
			const existing = workspaceLabels.find(
				(l) => l.name.toLowerCase() === name,
			);
			if (existing) {
				labelIds.push(existing.id);
				continue;
			}
			const labelId = randomId();
			const made = await run(
				zero.mutate(
					mutators.label.create({
						id: labelId,
						workspaceId: list.workspaceId,
						name: quick?.labels.find((n) => n.toLowerCase() === name) ?? name,
					}),
				),
			);
			if (!made) return;
			labelIds.push(labelId);
		}
		if (labelIds.length > 0)
			await run(zero.mutate(mutators.taskLabel.set({ taskId: id, labelIds })));
		// A task filed in another list is not on this screen, so say where it went.
		if (target.id !== list.id) setAdded({ list: target.title, id: randomId() });
	}

	const describedBy =
		[!canAttach && READ_ONLY_ID, problemText && REASON_ID]
			.filter(Boolean)
			.join(" ") || undefined;
	const blocked = !canAttach || listProblem;

	return (
		<div
			className={
				isDesktop ? "mb-5 flex flex-col gap-1" : "mt-2 flex flex-col gap-1"
			}
		>
			<div data-reading-inline-add className="flex gap-2">
				<TitleSuggestInput
					inputRef={inputRef}
					data-testid="new-task"
					disabled={!canAttach}
					aria-describedby={describedBy}
					placeholder={addCopy.placeholder()}
					value={text}
					onChange={change}
					onKeyDown={onKeyDown}
					onSubmit={() => void create()}
					candidates={candidates}
					listId={list.id}
				/>
				<Button
					data-testid="new-task-submit"
					disabled={blocked}
					aria-describedby={describedBy}
					type="button"
					className="min-h-11 md:min-h-0"
					onClick={() => void create()}
				>
					{addCopy.action()}
				</Button>
			</div>
			{chips.length > 0 && (
				<div
					className="flex h-11 items-center overflow-x-auto overflow-y-hidden"
					data-testid="list-composer-chips"
				>
					<TokenChips
						tokens={chips}
						unknownLabels={unknownLabels}
						onRemove={keepAsText}
						removeLabel={(token) => m.list_add_chip_keep({ token })}
					/>
				</div>
			)}
			{!canAttach && (
				<p id={READ_ONLY_ID} className="text-xs text-muted-foreground">
					{m.workspace_read_only()}
				</p>
			)}
			{problemText && (
				<p
					id={REASON_ID}
					role="status"
					className="text-xs text-muted-foreground"
				>
					{problemText}
				</p>
			)}
			<div role="status" aria-live="polite" className="sr-only">
				{added && (
					<span key={added.id}>
						{m.quickadd_added_to({ list: added.list })}
					</span>
				)}
			</div>
			{added && (
				<p aria-hidden="true" className="text-xs text-muted-foreground">
					{m.quickadd_added_to({ list: added.list })}
				</p>
			)}
		</div>
	);
}
