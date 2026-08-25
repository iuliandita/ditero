import { useZero } from "@rocicorp/zero/react";
import { Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
	SheetTrigger,
} from "@/components/ui/sheet";
import { ListIcon } from "@/lib/list-icon";
import { useIsDesktop } from "@/lib/use-media-query";
import { type ListKind, suggestIcon } from "../../../domain/icon-map.ts";
import { randomId } from "../../../domain/random-id.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import {
	STARTER_TEMPLATES,
	type TemplateContent,
} from "../../../domain/template.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type {
	Folder,
	List,
	schema,
	Template,
} from "../../../zero/schema.gen.ts";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";

// Kinds offered in the picker. habits exists in the enum but is intentionally
// hidden here (it is a recurring-by-nature kind, created elsewhere). `label` is a
// getter: this array is module-level, so resolving the message eagerly would
// freeze it at the import-time locale.
const PICKABLE_KINDS: { kind: ListKind; label: string }[] = [
	{
		kind: "tasks",
		get label() {
			return m.list_kind_tasks();
		},
	},
	{
		kind: "shopping",
		get label() {
			return m.list_kind_shopping();
		},
	},
	{
		kind: "checklist",
		get label() {
			return m.list_kind_checklist();
		},
	},
	{
		kind: "project",
		get label() {
			return m.list_kind_project();
		},
	},
];

const NONE = "__none__";
const BLANK = "__blank__";

// Live sort key placing a new list after the current last one.
function nextKey(lists: List[]): string {
	const last = lists.reduce<string | null>(
		(max, l) => (max == null || l.sortKey > max ? l.sortKey : max),
		null,
	);
	return keyBetween(last, null);
}

export function CreateList({
	workspaceId,
	lists,
	folders,
	templates,
	initialFolderId,
	onCreated,
}: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
	/** Preselected folder, e.g. from a folder row's "New list here". */
	initialFolderId?: string | null;
	onCreated?: () => void;
}) {
	const isDesktop = useIsDesktop();
	// Below md the form lives in a bottom sheet; at/above md it is inline so it
	// is always reachable (the spine e2e drives new-list without opening a menu).
	if (isDesktop) {
		return (
			<div className="rounded-xl border p-3">
				<Form
					workspaceId={workspaceId}
					lists={lists}
					folders={folders}
					templates={templates}
					initialFolderId={initialFolderId}
					onCreated={onCreated}
				/>
			</div>
		);
	}
	return (
		<MobileCreateList
			workspaceId={workspaceId}
			lists={lists}
			folders={folders}
			templates={templates}
			initialFolderId={initialFolderId}
			onCreated={onCreated}
		/>
	);
}

function MobileCreateList(props: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
	initialFolderId?: string | null;
	onCreated?: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button variant="outline" className="w-full justify-start">
					<Plus className="size-4" />
					{m.create_list_new_list()}
				</Button>
			</SheetTrigger>
			<SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>{m.create_list_new_list()}</SheetTitle>
				</SheetHeader>
				<div className="p-4 pt-0">
					<Form
						{...props}
						onCreated={() => {
							props.onCreated?.();
							setOpen(false);
						}}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}

function Form({
	workspaceId,
	lists,
	folders,
	templates,
	initialFolderId,
	onCreated,
}: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
	initialFolderId?: string | null;
	onCreated?: () => void;
}) {
	const zero = useZero<typeof schema>();
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<ListKind>("tasks");
	const [folderId, setFolderId] = useState<string>(initialFolderId ?? NONE);
	const [templateSel, setTemplateSel] = useState<string>(BLANK);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Synchronous in-flight guard: a fast double Enter fires before the `busy`
	// state re-render lands, so the ref (not stale state) blocks the second submit.
	const inFlight = useRef(false);
	const titleId = useId();

	const fromTemplate = templateSel !== BLANK;
	const listTemplates = templates.filter((t) => t.kind === "list");

	async function submit() {
		const t = title.trim();
		if (inFlight.current) return;
		// Blank lists need a title; template lists carry their own name.
		if (!fromTemplate && !t) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		try {
			const sortKey = nextKey(lists);
			const folder = folderId === NONE ? undefined : folderId;

			if (templateSel.startsWith("starter:")) {
				const content = STARTER_TEMPLATES[Number(templateSel.slice(8))];
				// Starters expand server-side in one tx (atomic, same path as DB
				// templates) rather than a client-side list+tasks loop.
				if (content && content.kind === "list") {
					await zero.mutate(
						mutators.template.instantiateContent({
							content,
							workspaceId,
							listId: randomId(),
							sortKey,
							name: t || defaultName(content),
							...(folder ? { folderId: folder } : {}),
						}),
					).client;
				}
			} else if (templateSel.startsWith("ws:")) {
				await zero.mutate(
					mutators.template.instantiateList({
						templateId: templateSel.slice(3),
						workspaceId,
						listId: randomId(),
						sortKey,
					}),
				).client;
			} else {
				await zero.mutate(
					mutators.list.create({
						id: randomId(),
						workspaceId,
						title: t,
						kind,
						sortKey,
						icon: suggestIcon(t, kind),
						...(folder ? { folderId: folder } : {}),
					}),
				).client;
			}
			setTitle("");
			setTemplateSel(BLANK);
			onCreated?.();
		} catch (e) {
			setError(mutationErrorMessage(e, m.create_list_failed));
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg border">
					<ListIcon icon={null} kind={kind} title={title} />
				</span>
				<input
					id={titleId}
					data-testid="new-list"
					className="h-9 flex-1 rounded-lg border bg-transparent px-3 text-base md:text-sm"
					placeholder={m.create_list_name_placeholder()}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit();
					}}
				/>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{PICKABLE_KINDS.map((k) => (
					<button
						key={k.kind}
						type="button"
						aria-pressed={kind === k.kind}
						onClick={() => setKind(k.kind)}
						className={`flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm ${
							kind === k.kind ? "border-ring bg-muted" : "text-muted-foreground"
						}`}
					>
						<ListIcon icon={null} kind={k.kind} title="" />
						{k.label}
					</button>
				))}
			</div>

			<div className="flex flex-col gap-2 sm:flex-row">
				<Select value={folderId} onValueChange={setFolderId}>
					<SelectTrigger
						aria-label={m.create_list_folder_label()}
						className="w-full sm:w-1/2"
					>
						<SelectValue placeholder={m.create_list_folder_label()} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>{m.create_list_no_folder()}</SelectItem>
						{folders.map((f) => (
							<SelectItem key={f.id} value={f.id}>
								{f.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select value={templateSel} onValueChange={setTemplateSel}>
					<SelectTrigger
						aria-label={m.create_list_template_label()}
						className="w-full sm:w-1/2"
					>
						<SelectValue placeholder={m.create_list_template_label()} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={BLANK}>
							{m.create_list_template_blank()}
						</SelectItem>
						{STARTER_TEMPLATES.map((content, i) => (
							<SelectItem
								// biome-ignore lint/suspicious/noArrayIndexKey: starters are a fixed constant list
								key={`starter-${i}`}
								value={`starter:${i}`}
							>
								{defaultName(content)}
							</SelectItem>
						))}
						{listTemplates.map((t) => (
							<SelectItem key={t.id} value={`ws:${t.id}`}>
								{t.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<Button
				data-testid="new-list-submit"
				type="button"
				onClick={() => void submit()}
				disabled={busy}
				className="self-end"
			>
				{m.create_list_submit()}
			</Button>
		</div>
	);
}

function defaultName(content: TemplateContent): string {
	if (content.kind !== "list") return m.template_default_name_generic();
	return {
		tasks: m.template_default_name_tasks(),
		shopping: m.template_default_name_shopping(),
		checklist: m.template_default_name_checklist(),
		project: m.template_default_name_project(),
		habits: m.template_default_name_habits(),
	}[content.listKind];
}
