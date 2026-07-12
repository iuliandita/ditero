import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo, useState } from "react";
import { keyBetween } from "../../domain/sort-key.ts";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";

export function ListView({ listId }: { listId: string }) {
	const zero = useZero<typeof schema>();
	const [tasks] = useQuery(queries.tasks.mine());
	const [title, setTitle] = useState("");

	const listTasks = useMemo(
		() => tasks.filter((t) => t.listId === listId),
		[tasks, listId],
	);

	async function createTask() {
		const t = title.trim();
		if (!t) return;
		await zero.mutate(
			mutators.task.create({
				id: crypto.randomUUID(),
				listId,
				title: t,
				sortKey: keyBetween(null, null),
			}),
		).client;
		setTitle("");
	}

	function toggle(id: string, done: boolean) {
		void zero.mutate(mutators.task.update({ id, done: !done })).client;
	}

	return (
		<div data-testid="list" className="mt-6 border-t pt-4">
			<div className="mb-4 flex gap-2">
				<input
					data-testid="new-task"
					className="flex-1 border p-2"
					placeholder="new task"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<button
					data-testid="new-task-submit"
					type="button"
					className="border bg-black p-2 text-white"
					onClick={createTask}
				>
					Add task
				</button>
			</div>
			<ul className="flex flex-col gap-1">
				{listTasks.map((t) => (
					<li key={t.id} className="flex items-center gap-2">
						<input
							type="checkbox"
							aria-label={t.title}
							checked={t.done ?? false}
							onChange={() => toggle(t.id, t.done ?? false)}
						/>
						<span>{t.title}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
