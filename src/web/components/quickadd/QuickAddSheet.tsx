import { useQuery, useZero } from "@rocicorp/zero/react";
import { Mic } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { ListKind } from "../../../domain/icon-map.ts";
import {
	dateParserFor,
	normalizeListName,
	parseQuickAdd,
	type QuickAddToken,
} from "../../../domain/quick-add.ts";
import { randomId } from "../../../domain/random-id.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type {
	Label,
	List,
	schema,
	Task,
	Workspace,
} from "../../../zero/schema.gen.ts";
import { useWorkspaceWriteAccess } from "../../hooks/useTaskImportActivation.ts";
import { isolated } from "../../lib/bidi.tsx";
import { addCopyFor } from "../../lib/kind-copy.ts";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";
import { useNativeAccount } from "../../lib/native-account.tsx";
import { useIsDesktop } from "../../lib/use-media-query.ts";
import { cn } from "../../lib/utils.ts";
import { SyntaxHint } from "./SyntaxHint.tsx";
import { TokenChips } from "./TokenChips.tsx";
import { useVoiceCapture } from "./useVoiceCapture.ts";
import { VoiceCapture } from "./VoiceCapture.tsx";

export function QuickAddSheet({
	open,
	onOpenChange,
	lists,
	workspaces,
	labels,
	tasks,
	currentListId,
	workspaceId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	lists: List[];
	workspaces: Workspace[];
	labels: Label[];
	tasks: Task[];
	currentListId: string | null;
	workspaceId: string;
}) {
	const zero = useZero<typeof schema>();
	const isDesktop = useIsDesktop();
	const [raw, setRaw] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const pickerSearchRef = useRef<HTMLInputElement>(null);
	const voiceRef = useRef<HTMLDivElement>(null);
	const [listNotice, setListNotice] = useState(0);
	const [allLists] = useQuery(queries.lists.mine());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerIndex, setPickerIndex] = useState(0);
	const [pickerAll, setPickerAll] = useState(false);
	const [pickerSearch, setPickerSearch] = useState("");
	const [due, setDue] = useState<Date | null>(null);
	const [dueOpen, setDueOpen] = useState(false);
	const [voiceRequested, setVoiceRequested] = useState(false);
	const [added, setAdded] = useState<{ list: string; id: string } | null>(null);

	useEffect(() => {
		if (open) inputRef.current?.focus();
		else {
			setRaw("");
			setError(null);
			setSelectedId(null);
			setPickerOpen(false);
			setDue(null);
			setDueOpen(false);
			setVoiceRequested(false);
			setAdded(null);
		}
	}, [open]);

	// changeLocale reloads the page, so this is constant for the component's
	// lifetime; read it here rather than at module scope, which would freeze the
	// import-time locale.
	const locale = getLocale();
	const availableLists = allLists;
	const parse = useMemo(
		() =>
			parseQuickAdd(
				raw,
				undefined,
				locale,
				availableLists.map((l) => l.title),
			),
		[raw, locale, availableLists],
	);
	const listToken = parse.tokens.find((t) => t.type === "list");
	const matches =
		parse.listName == null
			? []
			: availableLists.filter(
					(l) =>
						normalizeListName(l.title) ===
						normalizeListName(parse.listName ?? ""),
				);
	const resolvedList = selectedId
		? availableLists.find((l) => l.id === selectedId)
		: matches.length === 1
			? matches[0]
			: null;
	const listUnresolved = listToken != null && !resolvedList;
	const title = parse.title;
	const targetList =
		resolvedList ??
		(!listToken
			? (lists.find((l) => l.id === currentListId) ?? lists[0])
			: null) ??
		null;
	const pickerQuery = normalizeListName(
		pickerAll ? pickerSearch : (parse.listName ?? ""),
	);
	const pickerLists = availableLists
		.filter((l) => normalizeListName(l.title).includes(pickerQuery))
		.toSorted((a, b) => {
			const rank = (name: string) =>
				name === pickerQuery ? 0 : name.startsWith(pickerQuery) ? 1 : 2;
			return (
				rank(normalizeListName(a.title)) - rank(normalizeListName(b.title))
			);
		});
	useEffect(() => {
		if (pickerOpen && pickerAll) pickerSearchRef.current?.focus();
	}, [pickerOpen, pickerAll]);
	function selectList(list: List) {
		if (listToken)
			setRaw(
				(value) =>
					`${value.slice(0, listToken.start)}~${list.title}${value.slice(listToken.end)}`,
			);
		else
			setRaw((value) =>
				/(?:^|\s)~$/.test(value)
					? `${value}${list.title}`
					: `${value.trimEnd()} ~${list.title}`.trimStart(),
			);
		setSelectedId(list.id);
		setPickerOpen(false);
		inputRef.current?.focus();
	}
	const targetName =
		targetList &&
		availableLists.filter(
			(list) =>
				normalizeListName(list.title) === normalizeListName(targetList.title),
		).length > 1
			? `${targetList.title} / ${workspaces.find((workspace) => workspace.id === targetList.workspaceId)?.name ?? ""}`
			: (targetList?.title ?? "");
	const targetWs = targetList?.workspaceId ?? workspaceId;
	const canWriteWorkspace = useWorkspaceWriteAccess();
	const canCreate = canWriteWorkspace(targetWs);

	// Native shells (Android and desktop) provide the account context; the
	// controller refuses them. Any identity change cancels the session.
	const nativeAccount = useNativeAccount();
	const voice = useVoiceCapture({
		open: open && canCreate,
		accountId: zero.userID ?? "",
		native: nativeAccount !== null,
		currentListId,
		targetListId: targetList?.id ?? null,
		workspaceId: targetWs,
		locale,
	});

	// A not-ready pack is a quiet "keep typing" wait, so typing keeps focus;
	// otherwise focus the first voice step so the unmounted Dictate button
	// does not drop focus to the dialog. A phase that already placed focus
	// inside voice (Stop once listening starts) wins.
	const voicePackWait = useRef(false);
	voicePackWait.current =
		voice.state?.phase === "error" &&
		(voice.state.reason === "language-pack-downloadable" ||
			voice.state.reason === "language-pack-downloading");
	useEffect(() => {
		if (!voiceRequested) return;
		const root = voiceRef.current;
		if (root?.contains(document.activeElement)) return;
		if (voicePackWait.current) inputRef.current?.focus();
		else
			(
				root?.querySelector<HTMLElement>("button:not(:disabled)") ?? root
			)?.focus();
	}, [voiceRequested]);

	// Everything a voice result or a recovery announcement is only valid for.
	const voiceScope = JSON.stringify([
		open,
		zero.userID,
		nativeAccount !== null,
		currentListId,
		targetList?.id ?? null,
		targetWs,
		locale,
	]);

	// A refused Enter is announced through the always-mounted live region. The
	// sequence never repeats, so a repeated refusal remounts the child and is
	// read again; the notice only counts while voice still blocks in this scope.
	const blockedSeq = useRef(0);
	const [blockedNotice, setBlockedNotice] = useState<{
		scope: string;
		seq: number;
	} | null>(null);
	useEffect(() => {
		if (!voice.blocking) setBlockedNotice(null);
	}, [voice.blocking]);
	useEffect(() => {
		setBlockedNotice((n) => (n && n.scope !== voiceScope ? null : n));
	}, [voiceScope]);
	const blockedAnnouncement =
		blockedNotice && blockedNotice.scope === voiceScope && voice.blocking
			? blockedNotice.seq
			: null;

	function acceptVoiceText(index: number) {
		const next = voice.accept(raw, index);
		if (next === null) return;
		setRaw(next);
		inputRef.current?.focus();
	}

	// Escape ends an active voice session first; the next Escape closes. The
	// typed field gets focus back because the voice control that held it is gone.
	function onEscapeKeyDown(e: KeyboardEvent) {
		if (pickerOpen) {
			e.preventDefault();
			setPickerOpen(false);
			inputRef.current?.focus();
		} else if (voice.cancelIfActive()) {
			e.preventDefault();
			inputRef.current?.focus();
		}
	}
	const wsLabels = labels.filter((l) => l.workspaceId === targetWs);
	const unknownLabels = new Set(
		parse.labels
			.filter(
				(n) => !wsLabels.some((l) => l.name.toLowerCase() === n.toLowerCase()),
			)
			.map((n) => n.toLowerCase()),
	);

	const chips = parse.tokens.filter(
		(t) =>
			(t.type !== "list" || !listUnresolved) && (t.type !== "date" || !due),
	);

	function removeToken(token: QuickAddToken) {
		const next = (raw.slice(0, token.start) + raw.slice(token.end))
			.replace(/\s{2,}/g, " ")
			.replace(/^\s+/, "");
		setRaw(next);
		if (token.type === "list") setSelectedId(null);
		inputRef.current?.focus();
	}

	async function submit() {
		const t = title.trim();
		if (listUnresolved) {
			setListNotice((n) => n + 1);
			return;
		}
		if (busy || !canCreate || !targetList || !t) return;
		// Read fresh at event time: this still fences every write.
		if (voice.blockedNow()) {
			blockedSeq.current += 1;
			setBlockedNotice({ scope: voiceScope, seq: blockedSeq.current });
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const id = randomId();
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
					dueAt: (due ?? parse.dueAt)?.getTime() ?? null,
					dueAllDay: due ? true : parse.dueAllDay,
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
						const lid = randomId();
						await zero.mutate(
							mutators.label.create({ id: lid, workspaceId: targetWs, name }),
						).client;
						labelIds.push(lid);
					}
				}
				await zero.mutate(mutators.taskLabel.set({ taskId: id, labelIds }))
					.client;
			}
			setAdded({ list: targetName, id: randomId() });
			setSelectedId(null);
			setDue(null);
			setPickerOpen(false);
			// Serial entry: clear and keep the sheet open (Enter = add another).
			setRaw("");
			inputRef.current?.focus();
		} catch (e) {
			setError(mutationErrorMessage(e, m.quickadd_failed));
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		if (!added) return;
		const timer = setTimeout(() => setAdded(null), 3000);
		return () => clearTimeout(timer);
	}, [added]);

	const body = (
		<div className={cn("flex flex-col gap-3", !isDesktop && "p-4 pt-0")}>
			<input
				ref={inputRef}
				dir="auto"
				data-testid="quickadd-input"
				role="combobox"
				aria-expanded={pickerOpen && !pickerAll}
				aria-controls={
					pickerOpen && !pickerAll ? "quickadd-listbox" : undefined
				}
				aria-activedescendant={
					pickerOpen && !pickerAll && pickerLists.length
						? `quickadd-option-${pickerLists[Math.min(pickerIndex, pickerLists.length - 1)].id}`
						: undefined
				}
				aria-autocomplete="list"
				aria-describedby={
					[
						!canCreate && "quickadd-read-only",
						listUnresolved && "quickadd-list-reason",
					]
						.filter(Boolean)
						.join(" ") || undefined
				}
				aria-label={m.quickadd_input_label()}
				className="h-10 w-full rounded-lg border bg-transparent px-3 text-base md:text-sm [@media(pointer:coarse)]:min-h-11"
				// The `#`/`~`/`pN` sigils are literal parser grammar and stay
				// untranslated. The date example is not grammar: it has to be
				// a word the ACTIVE chrono parser accepts, and on locales with
				// no parser the hint drops it rather than advertising a syntax
				// that will not work there.
				placeholder={
					dateParserFor(locale)
						? m.quickadd_placeholder({
								date: m.quickadd_example_date(),
								priority: "p2",
								label: "#store",
								list: "~groceries",
							})
						: m.quickadd_placeholder_nodate({
								priority: "p2",
								label: "#store",
								list: "~groceries",
							})
				}
				value={raw}
				onChange={(e) => {
					const value = e.target.value;
					setRaw(value);
					setAdded(null);
					const next = parseQuickAdd(
						value,
						undefined,
						locale,
						availableLists.map((l) => l.title),
					);
					const nextToken = next.tokens.find((t) => t.type === "list");
					const nextMatches = availableLists.filter(
						(l) =>
							normalizeListName(l.title) ===
							normalizeListName(next.listName ?? ""),
					);
					if (next.listName !== parse.listName) setSelectedId(null);
					const atToken =
						nextToken && e.target.selectionStart === nextToken.end;
					const bare = /(?:^|\s)~$/.test(value);
					setPickerOpen(Boolean((atToken && nextMatches.length !== 1) || bare));
					setPickerAll(false);
					setPickerIndex(0);
					if (
						due &&
						next.tokens.some((t) => t.type === "date") &&
						!parse.tokens.some(
							(t) =>
								t.type === "date" &&
								t.text === next.tokens.find((n) => n.type === "date")?.text,
						)
					)
						setDue(null);
				}}
				onKeyDown={(e) => {
					if (
						pickerOpen &&
						pickerLists.length &&
						(e.key === "ArrowDown" || e.key === "ArrowUp")
					) {
						e.preventDefault();
						setPickerIndex(
							(i) =>
								(i + (e.key === "ArrowDown" ? 1 : -1) + pickerLists.length) %
								pickerLists.length,
						);
					} else if (
						pickerOpen &&
						pickerLists.length &&
						(e.key === "Enter" || e.key === "Tab")
					) {
						e.preventDefault();
						selectList(
							pickerLists[Math.min(pickerIndex, pickerLists.length - 1)],
						);
					} else if (e.key === "Enter") void submit();
				}}
			/>
			{!canCreate && (
				<p id="quickadd-read-only" className="text-sm text-muted-foreground">
					{m.workspace_read_only()}
				</p>
			)}
			<div
				className="flex h-11 items-center gap-1.5 overflow-x-auto overflow-y-hidden"
				data-testid="quickadd-metadata"
			>
				<TokenChips
					tokens={chips}
					unknownLabels={unknownLabels}
					onRemove={removeToken}
				/>
				{due && (
					<TokenChips
						tokens={[
							{
								type: "date",
								text: new Intl.DateTimeFormat(locale, {
									dateStyle: "medium",
								}).format(due),
								start: 0,
								end: 0,
							},
						]}
						unknownLabels={unknownLabels}
						onRemove={() => setDue(null)}
					/>
				)}
				<button
					type="button"
					className="min-h-11 rounded-md px-2 text-xs hover:bg-muted"
					aria-expanded={dueOpen}
					aria-controls="quickadd-due-options"
					onClick={() => setDueOpen(!dueOpen)}
				>
					{m.task_due_date_aria()}
				</button>
			</div>
			{dueOpen && (
				<div id="quickadd-due-options" className="flex gap-2">
					{[0, 1].map((offset) => (
						<Button
							key={offset}
							type="button"
							variant="ghost"
							onClick={() => {
								const date = new Date();
								date.setDate(date.getDate() + offset);
								date.setHours(12, 0, 0, 0);
								const dateToken = parse.tokens.find(
									(token) => token.type === "date",
								);
								if (dateToken) removeToken(dateToken);
								setDue(date);
								setDueOpen(false);
							}}
						>
							{offset ? m.due_tomorrow() : m.due_today()}
						</Button>
					))}
				</div>
			)}
			{pickerOpen && (
				<div>
					{pickerAll && (
						<input
							ref={pickerSearchRef}
							dir="auto"
							role="combobox"
							aria-expanded={pickerOpen}
							aria-controls="quickadd-listbox"
							aria-activedescendant={
								pickerLists.length
									? `quickadd-option-${pickerLists[Math.min(pickerIndex, pickerLists.length - 1)].id}`
									: undefined
							}
							aria-autocomplete="list"
							aria-label={m.quickadd_list_search()}
							value={pickerSearch}
							onChange={(e) => {
								setPickerSearch(e.target.value);
								setPickerIndex(0);
							}}
							onKeyDown={(e) => {
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									e.preventDefault();
									setPickerIndex((i) =>
										pickerLists.length
											? (i +
													(e.key === "ArrowDown" ? 1 : -1) +
													pickerLists.length) %
												pickerLists.length
											: 0,
									);
								} else if (e.key === "Enter" && pickerLists.length) {
									e.preventDefault();
									selectList(
										pickerLists[Math.min(pickerIndex, pickerLists.length - 1)],
									);
								}
							}}
							className="h-11 w-full rounded-md border px-2"
						/>
					)}
					<div
						id="quickadd-listbox"
						role="listbox"
						aria-label={m.field_list()}
						className="max-h-32 overflow-y-auto rounded-md border p-1"
					>
						{pickerLists.map((list, index) => (
							<button
								key={list.id}
								type="button"
								role="option"
								id={`quickadd-option-${list.id}`}
								tabIndex={-1}
								onMouseDown={(e) => e.preventDefault()}
								aria-selected={index === pickerIndex}
								className="flex min-h-11 w-full justify-between gap-2 rounded px-2 text-start text-sm aria-selected:bg-muted"
								onClick={() => selectList(list)}
							>
								<bdi>{list.title}</bdi>
								<span className="text-muted-foreground">
									<bdi>
										{workspaces.find((w) => w.id === list.workspaceId)?.name}
									</bdi>
								</span>
							</button>
						))}
					</div>
				</div>
			)}
			{listUnresolved && (
				<p id="quickadd-list-reason" className="text-sm text-muted-foreground">
					{matches.length > 1
						? m.quickadd_choose_list()
						: m.quickadd_list_not_found({ list: parse.listName ?? "" })}
				</p>
			)}
			<div role="status" aria-live="polite" className="sr-only">
				{listNotice > 0 && listUnresolved && (
					<span key={listNotice}>
						{matches.length > 1
							? m.quickadd_choose_list()
							: m.quickadd_list_not_found({ list: parse.listName ?? "" })}
					</span>
				)}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{voice.blocking && (
				<p
					id="quickadd-voice-blocked"
					className="text-xs text-muted-foreground"
				>
					{m.quickadd_voice_blocked()}
				</p>
			)}
			<div
				role="status"
				aria-live="polite"
				aria-atomic="true"
				data-testid="quickadd-voice-blocked-announcement"
				className="sr-only"
			>
				{blockedAnnouncement !== null && (
					<span key={blockedAnnouncement}>{m.quickadd_voice_blocked()}</span>
				)}
			</div>
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					aria-label={m.quickadd_choose_list()}
					aria-haspopup="listbox"
					aria-expanded={pickerOpen}
					className="min-h-11 min-w-0 truncate text-start text-xs text-muted-foreground"
					onClick={() => {
						setPickerAll(true);
						setPickerSearch("");
						setPickerOpen(true);
						setPickerIndex(0);
						inputRef.current?.focus();
					}}
				>
					<span>
						{added ? (
							<span key={added.id}>
								{isolated((list) => m.quickadd_added_to({ list }), added.list)}
							</span>
						) : targetList ? (
							isolated((list) => m.quickadd_adding_to({ list }), targetName)
						) : listUnresolved ? (
							matches.length > 1 ? (
								m.quickadd_choose_list()
							) : (
								m.quickadd_list_not_found({ list: parse.listName ?? "" })
							)
						) : (
							m.quickadd_no_list()
						)}
					</span>
				</button>
				<span role="status" aria-live="polite" className="sr-only">
					{added && (
						<span key={added.id}>
							{isolated((list) => m.quickadd_added_to({ list }), added.list)}
						</span>
					)}
				</span>
				<Button
					data-testid="quickadd-submit"
					type="button"
					className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
					onClick={() => void submit()}
					disabled={
						busy ||
						!canCreate ||
						!targetList ||
						!title.trim() ||
						voice.blocking ||
						listUnresolved
					}
					aria-describedby={
						[
							voice.blocking && "quickadd-voice-blocked",
							listUnresolved && "quickadd-list-reason",
						]
							.filter(Boolean)
							.join(" ") || undefined
					}
				>
					{addCopyFor(targetList?.kind as ListKind | null | undefined).action()}
				</Button>
			</div>
			{canCreate &&
				(voiceRequested ? (
					<div ref={voiceRef} tabIndex={-1}>
						<VoiceCapture
							key={voiceScope}
							voice={voice}
							onUse={acceptVoiceText}
							onFocusInput={() => inputRef.current?.focus()}
						/>
					</div>
				) : (
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 self-start"
						data-testid="quickadd-voice-start"
						onClick={() => {
							setVoiceRequested(true);
							if (
								voice.state?.phase === "idle" &&
								voice.state.ready &&
								voice.state.acknowledged
							)
								voice.start();
						}}
					>
						<Mic aria-hidden="true" />
						{m.quickadd_voice_start()}
					</Button>
				))}
			<SyntaxHint />
		</div>
	);

	// Desktop: a centered dialog, since a full-width bottom sheet on a wide
	// screen puts the field far from where the eye is. Phones keep the sheet.
	// sm:max-w-*: an unprefixed max-w loses to DialogContent's base sm:max-w-sm.
	if (isDesktop)
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					data-testid="quickadd-dialog"
					className="top-[15vh] max-h-[80dvh] translate-y-0 overflow-y-auto sm:max-w-lg"
					onEscapeKeyDown={onEscapeKeyDown}
				>
					<DialogHeader>
						<DialogTitle>{m.quickadd_sheet_title()}</DialogTitle>
					</DialogHeader>
					{body}
				</DialogContent>
			</Dialog>
		);
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="bottom"
				data-testid="quickadd-sheet"
				className="data-[side=bottom]:h-[min(36rem,90dvh)] overflow-y-auto"
				onEscapeKeyDown={onEscapeKeyDown}
			>
				<SheetHeader>
					<SheetTitle>{m.quickadd_sheet_title()}</SheetTitle>
				</SheetHeader>
				{body}
			</SheetContent>
		</Sheet>
	);
}
