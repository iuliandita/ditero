import { useZero } from "@rocicorp/zero/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	parseQuickAdd,
	type QuickAddToken,
} from "../../../domain/quick-add.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type { Label, List, schema, Task } from "../../../zero/schema.gen.ts";
import { TokenChips } from "./TokenChips.tsx";

// Case-insensitive prefix match against visible lists. Ambiguous prefixes stay
// unresolved unless one is an exact-name hit; unresolved names are not guessed
// (design: the raw ~token falls back into the title).
function resolveList(lists: List[], name: string): List | null {
	const n = name.trim().toLowerCase();
	if (!n) return null;
	const prefix = lists.filter((l) => l.title.toLowerCase().startsWith(n));
	if (prefix.length === 1) return prefix[0];
	return lists.find((l) => l.title.toLowerCase() === n) ?? null;
}

export function QuickAddSheet({
	open,
	onOpenChange,
	lists,
	labels,
	tasks,
	currentListId,
	workspaceId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	lists: List[];
	labels: Label[];
	tasks: Task[];
	currentListId: string | null;
	workspaceId: string;
}) {
	const zero = useZero<typeof schema>();
	const [raw, setRaw] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) inputRef.current?.focus();
		else {
			setRaw("");
			setError(null);
		}
	}, [open]);

	const parse = useMemo(() => parseQuickAdd(raw), [raw]);
	const resolvedList = parse.listName
		? resolveList(lists, parse.listName)
		: null;
	const listUnresolved = parse.listName != null && resolvedList == null;
	const listToken = parse.tokens.find((t) => t.type === "list");

	// Unresolved ~list stays in the title verbatim rather than being guessed.
	const title =
		listUnresolved && listToken
			? `${parse.title} ${listToken.text}`.trim()
			: parse.title;

	const targetList =
		resolvedList ??
		lists.find((l) => l.id === currentListId) ??
		lists[0] ??
		null;
	const targetWs = targetList?.workspaceId ?? workspaceId;
	const wsLabels = labels.filter((l) => l.workspaceId === targetWs);
	const unknownLabels = new Set(
		parse.labels
			.filter(
				(n) => !wsLabels.some((l) => l.name.toLowerCase() === n.toLowerCase()),
			)
			.map((n) => n.toLowerCase()),
	);

	const chips = listUnresolved
		? parse.tokens.filter((t) => t.type !== "list")
		: parse.tokens;

	function removeToken(token: QuickAddToken) {
		const next = (raw.slice(0, token.start) + raw.slice(token.end))
			.replace(/\s{2,}/g, " ")
			.replace(/^\s+/, "");
		setRaw(next);
		inputRef.current?.focus();
	}

	async function submit() {
		const t = title.trim();
		if (busy || !targetList || !t) return;
		setBusy(true);
		setError(null);
		try {
			const id = crypto.randomUUID();
			const openKeys = tasks.filter(
				(x) => x.listId === targetList.id && x.parentId == null && !x.done,
			);
			const last = openKeys.reduce<string | null>(
				(max, x) => (max == null || x.sortKey > max ? x.sortKey : max),
				null,
			);
			await zero.mutate(
				mutators.task.create({
					id,
					listId: targetList.id,
					title: t,
					sortKey: keyBetween(last, null),
					dueAt: parse.dueAt ? parse.dueAt.getTime() : null,
					dueAllDay: parse.dueAllDay,
					priority: parse.priority,
				}),
			).client;

			if (parse.labels.length > 0) {
				const labelIds: string[] = [];
				const seen = new Set<string>();
				for (const name of parse.labels) {
					const lower = name.toLowerCase();
					if (seen.has(lower)) continue;
					seen.add(lower);
					const existing = wsLabels.find((l) => l.name.toLowerCase() === lower);
					if (existing) labelIds.push(existing.id);
					else {
						const lid = crypto.randomUUID();
						await zero.mutate(
							mutators.label.create({ id: lid, workspaceId: targetWs, name }),
						).client;
						labelIds.push(lid);
					}
				}
				await zero.mutate(mutators.taskLabel.set({ taskId: id, labelIds }))
					.client;
			}
			// Serial entry: clear and keep the sheet open (Enter = add another).
			setRaw("");
			inputRef.current?.focus();
		} catch (e) {
			setError(e instanceof Error ? e.message : m.quickadd_failed());
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom">
				<SheetHeader>
					<SheetTitle>{m.quickadd_sheet_title()}</SheetTitle>
				</SheetHeader>
				<div className="flex flex-col gap-3 p-4 pt-0">
					<input
						ref={inputRef}
						data-testid="quickadd-input"
						aria-label={m.quickadd_input_label()}
						className="h-10 w-full rounded-lg border bg-transparent px-3 text-base md:text-sm"
						// Parser grammar, passed in rather than translated: the
						// `#`/`~`/`pN` sigils are literal syntax and chrono only
						// parses English date words.
						placeholder={m.quickadd_placeholder({
							date: "tomorrow",
							priority: "p2",
							label: "#store",
							list: "~groceries",
						})}
						value={raw}
						onChange={(e) => setRaw(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void submit();
						}}
					/>
					<TokenChips
						tokens={chips}
						unknownLabels={unknownLabels}
						onRemove={removeToken}
					/>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex items-center justify-between gap-2">
						<span className="truncate text-xs text-muted-foreground">
							{targetList
								? m.quickadd_adding_to({ list: targetList.title })
								: m.quickadd_no_list()}
						</span>
						<Button
							data-testid="quickadd-submit"
							type="button"
							onClick={() => void submit()}
							disabled={busy || !targetList || !title.trim()}
						>
							{m.list_add_task()}
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
