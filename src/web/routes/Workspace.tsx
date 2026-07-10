import { useQuery, useZero } from "@rocicorp/zero/react";
import { useEffect, useMemo, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { ListView } from "./ListView.tsx";

export function Workspace() {
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openListId, setOpenListId] = useState<string | null>(null);
	const [openSharedRequested, setOpenSharedRequested] = useState(false);
	const [title, setTitle] = useState("");

	// Default active workspace is the user's personal one, so new lists stay private.
	useEffect(() => {
		if (activeId) return;
		const personal = workspaces.find((w) => w.kind === "personal");
		if (personal) setActiveId(personal.id);
		else if (workspaces.length) setActiveId(workspaces[0].id);
	}, [workspaces, activeId]);

	const activeLists = useMemo(
		() => lists.filter((l) => l.workspaceId === activeId),
		[lists, activeId],
	);

	useEffect(() => {
		if (!openSharedRequested) return;
		const shared = workspaces.find((w) => w.kind === "shared");
		if (!shared) return;
		if (activeId !== shared.id) {
			setActiveId(shared.id);
			setOpenListId(null);
		}
		const firstList = lists.find((l) => l.workspaceId === shared.id);
		if (!firstList) return;
		setOpenListId(firstList.id);
		setOpenSharedRequested(false);
	}, [openSharedRequested, workspaces, lists, activeId]);

	async function createList() {
		const t = title.trim();
		if (!activeId || !t) return;
		await zero.mutate(
			mutators.list.create({
				id: crypto.randomUUID(),
				workspaceId: activeId,
				title: t,
			}),
		).client;
		setTitle("");
	}

	function selectWorkspace(id: string) {
		setActiveId(id);
		setOpenListId(null);
	}

	function openShared() {
		setOpenSharedRequested(true);
	}

	return (
		<div data-testid="workspace" className="mx-auto max-w-xl p-6">
			<div className="mb-4 flex items-center gap-2">
				{workspaces.map((w) => (
					<button
						key={w.id}
						type="button"
						className={`border px-2 py-1 ${w.id === activeId ? "bg-black text-white" : ""}`}
						onClick={() => selectWorkspace(w.id)}
					>
						{w.name}
					</button>
				))}
				<button
					data-testid="open-shared"
					type="button"
					className="border px-2 py-1"
					onClick={openShared}
				>
					Open shared
				</button>
			</div>

			<div className="mb-4 flex gap-2">
				<input
					data-testid="new-list"
					className="flex-1 border p-2"
					placeholder="new list"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<button
					data-testid="new-list-submit"
					type="button"
					className="border bg-black p-2 text-white"
					onClick={createList}
				>
					Add list
				</button>
			</div>

			<ul className="flex flex-col gap-1">
				{activeLists.map((l) => (
					<li key={l.id}>
						<button
							type="button"
							className="w-full border p-2 text-left"
							onClick={() => setOpenListId(l.id)}
						>
							{l.title}
						</button>
					</li>
				))}
			</ul>

			{openListId ? <ListView listId={openListId} /> : null}
		</div>
	);
}
