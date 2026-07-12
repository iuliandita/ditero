import { useZero } from "@rocicorp/zero/react";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
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
import { keyBetween } from "../../../domain/sort-key.ts";
import {
	instantiate,
	STARTER_TEMPLATES,
	type TemplateContent,
} from "../../../domain/template.ts";
import { mutators } from "../../../zero/mutators.ts";
import type {
	Folder,
	List,
	schema,
	Template,
} from "../../../zero/schema.gen.ts";

// Kinds offered in the picker. habits exists in the enum but is intentionally
// hidden here (it is a recurring-by-nature kind, created elsewhere).
const PICKABLE_KINDS: { kind: ListKind; label: string }[] = [
	{ kind: "tasks", label: "Tasks" },
	{ kind: "shopping", label: "Shopping" },
	{ kind: "checklist", label: "Checklist" },
	{ kind: "project", label: "Project" },
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
	onCreated,
}: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
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
			onCreated={onCreated}
		/>
	);
}

function MobileCreateList(props: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
	onCreated?: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button variant="outline" className="w-full justify-start">
					<Plus className="size-4" />
					New list
				</Button>
			</SheetTrigger>
			<SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>New list</SheetTitle>
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
	onCreated,
}: {
	workspaceId: string;
	lists: List[];
	folders: Folder[];
	templates: Template[];
	onCreated?: () => void;
}) {
	const zero = useZero<typeof schema>();
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<ListKind>("tasks");
	const [folderId, setFolderId] = useState<string>(NONE);
	const [templateSel, setTemplateSel] = useState<string>(BLANK);
	const [busy, setBusy] = useState(false);
	const titleId = useId();

	const fromTemplate = templateSel !== BLANK;
	const listTemplates = templates.filter((t) => t.kind === "list");

	async function submit() {
		const t = title.trim();
		if (busy) return;
		// Blank lists need a title; template lists carry their own name.
		if (!fromTemplate && !t) return;
		setBusy(true);
		try {
			const sortKey = nextKey(lists);
			const folder = folderId === NONE ? undefined : folderId;

			if (templateSel.startsWith("starter:")) {
				const content = STARTER_TEMPLATES[Number(templateSel.slice(8))];
				if (content) await createFromContent(content, t, sortKey, folder);
			} else if (templateSel.startsWith("ws:")) {
				await zero.mutate(
					mutators.template.instantiateList({
						templateId: templateSel.slice(3),
						workspaceId,
						listId: crypto.randomUUID(),
						sortKey,
					}),
				).client;
			} else {
				await zero.mutate(
					mutators.list.create({
						id: crypto.randomUUID(),
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
		} finally {
			setBusy(false);
		}
	}

	// Client-side expansion of a starter (a code constant, not a DB template):
	// build the list + its tasks with fresh ids and insert them.
	async function createFromContent(
		content: TemplateContent,
		overrideTitle: string,
		sortKey: string,
		folder: string | undefined,
	) {
		if (content.kind !== "list") return;
		const { list, tasks } = instantiate(
			content,
			() => crypto.randomUUID(),
			keyBetween,
			{ sortKey, title: overrideTitle || defaultName(content) },
		);
		if (!list) return;
		await zero.mutate(
			mutators.list.create({
				id: list.id,
				workspaceId,
				title: list.title,
				kind: list.kind,
				sortKey: list.sortKey,
				...(list.icon ? { icon: list.icon } : {}),
				...(folder ? { folderId: folder } : {}),
			}),
		).client;
		for (const task of tasks) {
			await zero.mutate(
				mutators.task.create({
					id: task.id,
					listId: list.id,
					title: task.title,
					sortKey: task.sortKey,
					...(task.parentId ? { parentId: task.parentId } : {}),
					...(task.notes ? { notes: task.notes } : {}),
					...(task.priority ? { priority: task.priority } : {}),
					...(task.quantity ? { quantity: task.quantity } : {}),
					...(task.unit ? { unit: task.unit } : {}),
					...(task.category ? { category: task.category } : {}),
				}),
			).client;
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
					placeholder="List name"
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
						className={`flex min-h-[36px] items-center gap-1.5 rounded-lg border px-2.5 text-sm ${
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
					<SelectTrigger className="w-full sm:w-1/2">
						<SelectValue placeholder="Folder" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>No folder</SelectItem>
						{folders.map((f) => (
							<SelectItem key={f.id} value={f.id}>
								{f.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select value={templateSel} onValueChange={setTemplateSel}>
					<SelectTrigger className="w-full sm:w-1/2">
						<SelectValue placeholder="Start from template" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={BLANK}>Blank</SelectItem>
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

			<Button
				data-testid="new-list-submit"
				type="button"
				onClick={() => void submit()}
				disabled={busy}
				className="self-end"
			>
				Add list
			</Button>
		</div>
	);
}

function defaultName(content: TemplateContent): string {
	if (content.kind !== "list") return "List";
	return {
		tasks: "Tasks",
		shopping: "Shopping list",
		checklist: "Checklist",
		project: "Project",
		habits: "Habits",
	}[content.listKind];
}
