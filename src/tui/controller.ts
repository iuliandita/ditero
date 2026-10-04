import type { TaskIntent } from "../agent/task-plan.ts";
import { CliError } from "../cli/arguments.ts";
import { MAX_PAGES, MAX_TOTAL_BYTES } from "../cli/client.ts";
import { MAX_INPUT_BYTES } from "../cli/task-workflow.ts";
import { PUBLIC_API_RESOURCES } from "../domain/public-api-resources.ts";
import {
	type ApiTaskDelete,
	parseApiTaskDelete,
} from "../domain/public-api-task-deletion.ts";
import {
	type ApiTaskUpdate,
	parseApiTaskUpdate,
} from "../domain/public-api-task-update.ts";
import type { ApiTaskCreate } from "../domain/public-api-writes.ts";
import type {
	DeletionObservation,
	Entry,
	Location,
	TaskObservation,
	TerminalApi,
} from "./api.ts";
import type { TerminalInput } from "./terminal.ts";

export type Review = {
	readonly requestId: string;
	readonly list?: Readonly<{ id: string; name: string }>;
	uncertain: boolean;
} & (
	| { kind: "update"; taskId: string; title: string; body: ApiTaskUpdate }
	| { kind: "delete"; taskId: string; title: string; body: ApiTaskDelete }
	| { kind: "create"; task: ApiTaskCreate; timezone: string }
	| {
			kind: "complete";
			task: { id: string; listId: string; dueAt: string | null };
			title: string;
			recurring: boolean;
	  }
);
export interface TerminalState {
	location: Location | null;
	entries: Entry[];
	selected: number;
	status: "ready" | "loading" | "empty" | "error" | "review" | "writing";
	error: string | null;
	nextCursor: string | null;
	detail: Entry | null;
	detailOffset: number;
	help: boolean;
	payload: boolean;
	page: number;
	breadcrumb: string[];
	authorityRefused: boolean;
	form:
		| {
				kind: "create";
				target: TaskIntent["target"];
				title: string;
				due: string;
				field: "title" | "due";
		  }
		| {
				kind: "update";
				observation: TaskObservation;
				title: string;
				notes: string;
				due: string;
				allDay: boolean;
				priority: string;
				field: "title" | "notes" | "due" | "allDay" | "priority";
				dirty: Partial<
					Record<"title" | "notes" | "due" | "allDay" | "priority", true>
				>;
		  }
		| null;
	deletion: {
		taskId: string;
		observation: DeletionObservation;
		cascade: boolean | null;
	} | null;
	review: Review | null;
}

export class TerminalController {
	readonly state: TerminalState = {
		location: null,
		entries: [],
		selected: 0,
		status: "ready",
		error: null,
		nextCursor: null,
		detail: null,
		detailOffset: 0,
		help: false,
		payload: false,
		page: 0,
		breadcrumb: [],
		authorityRefused: false,
		form: null,
		deletion: null,
		review: null,
	};
	private epoch = 0;
	private request = new AbortController();
	private stack: { location: Location; breadcrumb: string[] }[] = [];
	private cursors = new Set<string>();
	private pages = 0;
	private bytes = 0;
	private closed = false;
	private detailLines = 0;
	constructor(
		private api: TerminalApi,
		private changed: () => void,
		private quit: () => void,
		private uuid: () => string = () => crypto.randomUUID(),
	) {}

	close(): void {
		this.closed = true;
		this.epoch++;
		this.request.abort();
	}
	setDetailLines(count: number): void {
		this.detailLines = Math.max(0, Math.floor(count));
		this.state.detailOffset = Math.max(
			0,
			Math.min(this.state.detailOffset, this.detailLines - 1),
		);
	}
	private begin(): number {
		this.request.abort();
		this.request = new AbortController();
		return ++this.epoch;
	}
	private active(epoch: number): boolean {
		return !this.closed && epoch === this.epoch;
	}
	private failed(error: unknown): void {
		this.state.status = "error";
		this.state.error =
			error instanceof CliError ? error.code : "request_failed";
		if (
			error instanceof CliError &&
			[401, 403, 404, 410].includes(error.status ?? 0)
		) {
			this.state.entries = [];
			this.state.breadcrumb = [];
			this.state.page = 0;
			this.state.authorityRefused = true;
			this.state.payload = false;
			this.state.help = false;
			this.state.detail = null;
			this.state.form = null;
			this.state.deletion = null;
			this.state.review = null;
		}
		if (error instanceof CliError && error.status === 409)
			this.state.review = null;
	}
	async open(
		location: Location | null,
		nextPage = false,
		breadcrumb?: readonly string[],
	): Promise<void> {
		if (this.closed || this.state.status === "writing") return;
		const epoch = this.begin();
		if (breadcrumb) this.state.breadcrumb = [...breadcrumb];
		else if (
			!location ||
			location.resource !== this.state.location?.resource ||
			location.listId !== this.state.location?.listId ||
			location.workspaceId !== this.state.location?.workspaceId
		)
			this.state.breadcrumb = [];
		if (!nextPage) {
			this.cursors.clear();
			this.pages = 0;
			this.bytes = 0;
		}
		this.state.location = location;
		this.state.entries = [];
		this.state.page = 0;
		this.state.detail = null;
		this.state.detailOffset = 0;
		this.state.help = false;
		this.state.payload = false;
		this.state.form = null;
		this.state.deletion = null;
		this.state.review = null;
		this.state.selected = 0;
		this.state.error = null;
		this.state.nextCursor = null;
		if (!location) {
			this.state.status = "ready";
			this.changed();
			return;
		}
		this.state.status = "loading";
		this.changed();
		try {
			if (
				++this.pages > MAX_PAGES ||
				(location.cursor && this.cursors.has(location.cursor))
			)
				throw new CliError(
					"pagination_limit",
					"Refresh to start a new bounded collection.",
					8,
				);
			if (location.cursor) this.cursors.add(location.cursor);
			const page = await this.api.read(location, this.request.signal);
			if (!this.active(epoch)) return;
			this.bytes += new TextEncoder().encode(JSON.stringify(page)).length;
			if (
				this.bytes > MAX_TOTAL_BYTES ||
				(page.nextCursor && this.cursors.has(page.nextCursor))
			)
				throw new CliError(
					"pagination_limit",
					"Refresh to start a new bounded collection.",
					8,
				);
			this.state.entries = page.entries;
			this.state.page = this.pages;
			this.state.authorityRefused = false;
			this.state.nextCursor = page.nextCursor;
			this.state.status = page.entries.length ? "ready" : "empty";
		} catch (error) {
			if (this.active(epoch)) this.failed(error);
		}
		if (this.active(epoch)) this.changed();
	}
	private capturedList(
		id: string,
	): Readonly<{ id: string; name: string }> | undefined {
		const location = this.state.location;
		const name =
			location?.resource === "tasks" && location.listId === id
				? this.state.breadcrumb.at(-1)
				: location?.resource === "lists"
					? this.state.entries.find((entry) => entry.id === id)?.label
					: undefined;
		return name === undefined ? undefined : Object.freeze({ id, name });
	}

	private newTask(): void {
		const location = this.state.location;
		const selected = this.state.entries[this.state.selected];
		let target: TaskIntent["target"];
		if (location?.resource === "dashboards" && selected)
			target = {
				kind: "dashboard",
				selector: { id: selected.id },
				personal: false,
			};
		else if (location?.resource === "tasks" && location.listId)
			target = {
				kind: "list",
				selector: { id: location.listId },
				personal: false,
			};
		else if (location?.resource === "lists" && selected)
			target = { kind: "list", selector: { id: selected.id }, personal: false };
		else return;
		this.state.detail = null;
		this.state.detailOffset = 0;
		this.state.form = {
			kind: "create",
			target,
			title: "",
			due: "",
			field: "title",
		};
		this.state.error = null;
	}
	private async plan(): Promise<void> {
		const form = this.state.form;
		if (form?.kind !== "create" || !form.title.trim()) return;
		const epoch = this.begin();
		this.state.status = "loading";
		this.changed();
		try {
			const proposal = await this.api.plan(
				{
					title: form.title,
					notes: null,
					target: form.target,
					due: form.due ? { day: form.due } : null,
					priority: 0,
					assignees: [],
					labels: [],
				},
				this.request.signal,
			);
			if (!this.active(epoch)) return;
			this.state.detailOffset = 0;
			this.state.payload = false;
			this.state.help = false;
			const capturedTask = structuredClone(proposal.task);
			Object.freeze(capturedTask.assigneeIds);
			Object.freeze(capturedTask.labelIds);
			Object.freeze(capturedTask);
			this.state.review = {
				kind: "create",
				list: this.capturedList(capturedTask.listId),
				task: capturedTask,
				timezone: proposal.timezone,
				requestId: this.uuid(),
				uncertain: false,
			};
			this.state.form = null;
			this.state.status = "review";
		} catch (error) {
			if (this.active(epoch)) this.failed(error);
		}
		if (this.active(epoch)) this.changed();
	}
	private completion(): void {
		const selected = this.state.entries[this.state.selected];
		if (this.state.location?.resource !== "tasks" || !selected) return;
		const task = selected.data;
		if (
			typeof task.listId !== "string" ||
			(task.dueAt !== null && typeof task.dueAt !== "string")
		)
			return;
		this.state.detail = null;
		this.state.detailOffset = 0;
		this.state.payload = false;
		this.state.help = false;
		this.state.review = {
			kind: "complete",
			list: this.capturedList(task.listId),
			requestId: this.uuid(),
			uncertain: false,
			task: Object.freeze({
				id: selected.id,
				listId: task.listId,
				dueAt: task.dueAt,
			}),
			title: selected.label,
			recurring: typeof task.rrule === "string",
		};
		this.state.status = "review";
		this.state.error = null;
	}
	private async observeMutation(kind: "update" | "delete"): Promise<void> {
		const selected = this.state.entries[this.state.selected];
		if (this.state.location?.resource !== "tasks" || !selected) return;
		const taskId = selected.id;
		const epoch = this.begin();
		this.state.detail = null;
		this.state.detailOffset = 0;
		this.state.error = null;
		this.state.status = "loading";
		this.changed();
		try {
			if (kind === "update") {
				const observation = await this.api.observe(taskId, this.request.signal);
				if (!this.active(epoch)) return;
				const snapshot = observation.snapshot;
				this.state.form = {
					kind,
					observation: structuredClone(observation),
					title: snapshot.title,
					notes: snapshot.notes ?? "",
					due: snapshot.dueAt ?? "",
					allDay: snapshot.dueAllDay,
					priority: String(snapshot.priority),
					field: "title",
					dirty: {},
				};
			} else {
				const observation = await this.api.observeDeletion(
					taskId,
					this.request.signal,
				);
				if (!this.active(epoch)) return;
				this.state.deletion = {
					taskId,
					observation: structuredClone(observation),
					cascade: null,
				};
			}
			this.state.status = "ready";
		} catch (error) {
			if (this.active(epoch)) this.failed(error);
		}
		if (this.active(epoch)) this.changed();
	}
	private reviewUpdate(): void {
		const form = this.state.form;
		if (form?.kind !== "update") return;
		const old = form.observation.snapshot;
		const patch: ApiTaskUpdate["patch"] = {};
		if (form.dirty.priority && !/^[0-3]$/.test(form.priority)) {
			this.state.error = "invalid_input";
			return;
		}
		if (form.dirty.title && form.title.trim() !== old.title)
			patch.title = form.title;
		if (form.dirty.notes && (form.notes || null) !== old.notes)
			patch.notes = form.notes || null;
		if (form.dirty.due && form.due !== (old.dueAt ?? "")) {
			patch.dueAt = form.due || null;
			if (!form.due) patch.dueAllDay = false;
		}
		if (form.dirty.allDay && form.allDay !== old.dueAllDay)
			patch.dueAllDay = form.allDay;
		if (form.dirty.priority && Number(form.priority) !== old.priority)
			patch.priority = Number(form.priority);
		if (!Object.keys(patch).length) {
			this.state.error = "no_changes";
			return;
		}
		try {
			const body = parseApiTaskUpdate({
				listId: old.listId,
				expectedState: form.observation.stateToken,
				patch,
			});
			if (
				(body.patch.dueAllDay ?? old.dueAllDay) &&
				(body.patch.dueAt === null ||
					(body.patch.dueAt === undefined && old.dueAt === null))
			)
				throw new Error("A due instant is required");
			if (
				new TextEncoder().encode(JSON.stringify(body)).length > MAX_INPUT_BYTES
			)
				throw new Error("Input limit");
			Object.freeze(body.patch);
			this.state.payload = false;
			this.state.help = false;
			this.state.review = {
				kind: "update",
				list: this.capturedList(body.listId),
				taskId: old.taskId,
				title: old.title,
				body: Object.freeze(body),
				requestId: this.uuid(),
				uncertain: false,
			};
			this.state.form = null;
			this.state.detailOffset = 0;
			this.state.status = "review";
			this.state.error = null;
		} catch {
			this.state.error = "invalid_input";
		}
	}
	private editInput(input: TerminalInput): void {
		const form = this.state.form;
		if (form?.kind !== "update") return;
		if (input.type === "key" && input.key === "escape") {
			this.begin();
			this.state.form = null;
			this.state.status = "ready";
			return;
		}
		this.state.error = null;
		if (input.type === "key" && input.key === "enter") {
			const fields: readonly (typeof form.field)[] =
				form.observation.snapshot.rrule !== null ||
				form.observation.snapshot.listKind === "habits"
					? (["title", "notes", "priority"] as const)
					: (["title", "notes", "due", "allDay", "priority"] as const);
			const index = fields.indexOf(form.field);
			if (index === fields.length - 1) this.reviewUpdate();
			else {
				form.field = fields[index + 1];
				this.state.detailOffset = 0;
			}
		} else if (form.field === "allDay") {
			if (input.type === "text" && ["0", "1"].includes(input.text)) {
				form.allDay = input.text === "1";
				form.dirty.allDay = true;
			}
		} else if (input.type === "key" && input.key === "backspace") {
			form[form.field] = Array.from(form[form.field]).slice(0, -1).join("");
			form.dirty[form.field] = true;
		} else if (input.type === "text" || input.type === "paste") {
			const value =
				form.field === "notes"
					? input.text.replace(/\r\n?/g, "\n")
					: input.text.replace(/[\r\n\t]/g, " ");
			const maximum = { title: 500, notes: 32768, due: 64, priority: 1 }[
				form.field
			];
			if (form[form.field].length + value.length <= maximum) {
				form[form.field] += value;
				form.dirty[form.field] = true;
			}
		}
	}
	private deletionInput(input: TerminalInput): void {
		const deletion = this.state.deletion;
		if (!deletion) return;
		if (input.type === "text" && input.text === "q") {
			this.close();
			this.quit();
			return;
		}
		if (input.type === "key" && input.key === "escape") {
			this.state.deletion = null;
			return;
		}
		if (
			input.type === "text" &&
			input.text === "1" &&
			deletion.observation.childrenState.count === 0
		)
			deletion.cascade = false;
		if (input.type === "text" && input.text === "2") deletion.cascade = true;
		if (
			input.type === "key" &&
			input.key === "enter" &&
			deletion.cascade !== null
		) {
			const body = parseApiTaskDelete({
				listId: deletion.observation.snapshot.listId,
				expectedState: deletion.observation.stateToken,
				expectedChildrenState: deletion.observation.childrenState,
				cascadeChildren: deletion.cascade,
			});
			Object.freeze(body.expectedChildrenState);
			this.state.payload = false;
			this.state.help = false;
			this.state.review = {
				kind: "delete",
				list: this.capturedList(body.listId),
				taskId: deletion.taskId,
				title: deletion.observation.snapshot.title,
				body: Object.freeze(body),
				requestId: this.uuid(),
				uncertain: false,
			};
			this.state.deletion = null;
			this.state.detailOffset = 0;
			this.state.status = "review";
		}
	}

	private async write(): Promise<void> {
		const review = this.state.review;
		if (!review || this.state.status === "writing") return;
		const epoch = this.begin();
		review.uncertain = true;
		this.state.status = "writing";
		this.state.error = null;
		this.changed();
		try {
			if (review.kind === "create")
				await this.api.create(
					review.task,
					review.requestId,
					this.request.signal,
				);
			else if (review.kind === "update")
				await this.api.update(
					review.taskId,
					review.body,
					review.requestId,
					this.request.signal,
				);
			else if (review.kind === "delete")
				await this.api.delete(
					review.taskId,
					review.body,
					review.requestId,
					this.request.signal,
				);
			else
				await this.api.complete(
					review.task,
					review.requestId,
					this.request.signal,
				);
			if (!this.active(epoch)) return;
			this.state.review = null;
			this.state.status = "ready";
			await this.open(this.state.location);
		} catch (error) {
			if (this.active(epoch)) this.failed(error);
		}
		if (this.active(epoch)) this.changed();
	}
	async input(input: TerminalInput): Promise<void> {
		if (this.closed) return;
		if (input.type === "key" && input.key === "ctrl-c") {
			this.close();
			this.quit();
			return;
		}
		if (this.state.status === "writing") {
			if (input.type === "text" && input.text === "q") {
				this.close();
				this.quit();
			}
			return;
		}
		if (
			(this.state.detail ||
				this.state.review ||
				this.state.help ||
				this.state.deletion ||
				this.state.form?.kind === "update") &&
			input.type === "key" &&
			["up", "down", "home", "end"].includes(input.key)
		) {
			if (input.key === "up")
				this.state.detailOffset = Math.max(0, this.state.detailOffset - 1);
			if (input.key === "down")
				this.state.detailOffset = Math.min(
					Math.max(0, this.detailLines - 1),
					this.state.detailOffset + 1,
				);
			if (input.key === "home") this.state.detailOffset = 0;
			if (input.key === "end")
				this.state.detailOffset = Math.max(0, this.detailLines - 1);
			this.changed();
			return;
		}
		if (input.type === "invalid") {
			this.state.error = input.reason;
			this.changed();
			return;
		}
		if (this.state.deletion) {
			this.deletionInput(input);
			this.changed();
			return;
		}
		const form = this.state.form;
		if (form?.kind === "update") {
			this.editInput(input);
			this.changed();
			return;
		}
		if (form) {
			if (
				this.state.status === "loading" &&
				!(input.type === "key" && input.key === "escape")
			)
				return;
			if (input.type === "key" && input.key === "escape") {
				this.begin();
				this.state.form = null;
				this.state.status = "ready";
			} else if (input.type === "key" && input.key === "backspace")
				form[form.field] = Array.from(form[form.field]).slice(0, -1).join("");
			else if (input.type === "key" && input.key === "enter") {
				if (this.state.status === "loading") return;
				if (form.field === "title" && form.title.trim()) form.field = "due";
				else if (form.field === "due") await this.plan();
			} else if (input.type === "text" || input.type === "paste") {
				const value = input.text.replace(/[\r\n\t]/g, " ");
				const maximum = form.field === "title" ? 500 : 10;
				if (form[form.field].length + value.length <= maximum)
					form[form.field] += value;
			}
			this.changed();
			return;
		}
		if (this.state.review) {
			if (input.type === "text" && input.text === "?") {
				this.state.help = !this.state.help;
				this.state.detailOffset = 0;
			} else if (
				this.state.help &&
				input.type === "key" &&
				input.key === "escape"
			) {
				this.state.help = false;
			} else if (input.type === "text" && input.text === "v") {
				this.state.help = false;
				this.state.payload = !this.state.payload;
				this.state.detailOffset = 0;
			} else if (
				!this.state.help &&
				input.type === "text" &&
				((input.text === "y" && !this.state.review.uncertain) ||
					(input.text === "r" && this.state.review.uncertain))
			)
				await this.write();
			else if (
				input.type === "key" &&
				input.key === "escape" &&
				!this.state.review.uncertain &&
				!this.state.help
			) {
				this.state.review = null;
				this.state.payload = false;
				this.state.status = "ready";
			} else if (input.type === "text" && input.text === "q") {
				this.close();
				this.quit();
			}
			this.changed();
			return;
		}
		if (input.type === "paste") return;
		if (this.state.detail && input.type === "text" && input.text === "v") {
			this.state.payload = !this.state.payload;
			this.state.detailOffset = 0;
			this.changed();
			return;
		}
		if (input.type === "text" && input.text === "?") {
			this.state.help = !this.state.help;
			if (this.state.help) this.state.detailOffset = 0;
			this.changed();
			return;
		}
		if (this.state.help && input.type === "key" && input.key === "escape") {
			this.state.help = false;
			this.changed();
			return;
		}
		if (this.state.help && !(input.type === "text" && input.text === "q"))
			return;
		if (input.type === "text") {
			if (input.text === "q") {
				this.close();
				this.quit();
			} else if (input.text === "r")
				await this.open(
					this.state.location
						? { ...this.state.location, cursor: undefined }
						: null,
				);
			else if (
				input.text === "p" &&
				this.state.nextCursor &&
				this.state.location
			)
				await this.open(
					{ ...this.state.location, cursor: this.state.nextCursor },
					true,
				);
			else if (
				input.text === "n" &&
				!["loading", "error"].includes(this.state.status)
			)
				this.newTask();
			else if (["e", "d"].includes(input.text) && this.state.status === "ready")
				await this.observeMutation(input.text === "e" ? "update" : "delete");
			else if (input.text === "c" && this.state.status === "ready")
				this.completion();
		} else if (input.type === "key") {
			const count = this.state.location
				? this.state.entries.length
				: PUBLIC_API_RESOURCES.length;
			if (input.key === "up")
				this.state.selected = Math.max(0, this.state.selected - 1);
			else if (input.key === "down")
				this.state.selected = Math.min(
					Math.max(0, count - 1),
					this.state.selected + 1,
				);
			else if (input.key === "home") this.state.selected = 0;
			else if (input.key === "end")
				this.state.selected = Math.max(0, count - 1);
			else if (input.key === "escape" || input.key === "left") {
				if (this.state.detail) {
					this.state.detail = null;
					this.state.payload = false;
				} else {
					const prior = this.stack.pop();
					await this.open(prior?.location ?? null, false, prior?.breadcrumb);
				}
			} else if (input.key === "enter" || input.key === "right") {
				if (!this.state.location)
					await this.open({
						resource: PUBLIC_API_RESOURCES[this.state.selected],
					});
				else {
					const selected = this.state.entries[this.state.selected];
					if (!selected) return;
					if (
						this.state.location.resource === "workspaces" ||
						this.state.location.resource === "lists"
					) {
						this.stack.push({
							location: this.state.location,
							breadcrumb: [...this.state.breadcrumb],
						});
						await this.open(
							this.state.location.resource === "workspaces"
								? { resource: "lists", workspaceId: selected.id }
								: { resource: "tasks", listId: selected.id },
							false,
							[...this.state.breadcrumb, selected.label],
						);
					} else {
						this.state.detail = selected;
						this.state.detailOffset = 0;
					}
				}
			}
		}
		if (!this.closed) this.changed();
	}
}
