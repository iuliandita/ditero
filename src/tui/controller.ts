import type { TaskIntent } from "../agent/task-plan.ts";
import { CliError } from "../cli/arguments.ts";
import { MAX_PAGES, MAX_TOTAL_BYTES } from "../cli/client.ts";
import { PUBLIC_API_RESOURCES } from "../domain/public-api-resources.ts";
import type { ApiTaskCreate } from "../domain/public-api-writes.ts";
import type { Entry, Location, TerminalApi } from "./api.ts";
import type { TerminalInput } from "./terminal.ts";

export type Review = {
	requestId: string;
	uncertain: boolean;
} & (
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
	form: {
		target: TaskIntent["target"];
		title: string;
		due: string;
		field: "title" | "due";
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
		form: null,
		review: null,
	};
	private epoch = 0;
	private request = new AbortController();
	private stack: Location[] = [];
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
			this.state.detail = null;
			this.state.form = null;
			this.state.review = null;
		}
		if (error instanceof CliError && error.status === 409)
			this.state.review = null;
	}
	async open(location: Location | null, nextPage = false): Promise<void> {
		if (this.closed || this.state.status === "writing") return;
		const epoch = this.begin();
		if (!nextPage) {
			this.cursors.clear();
			this.pages = 0;
			this.bytes = 0;
		}
		this.state.location = location;
		this.state.entries = [];
		this.state.detail = null;
		this.state.detailOffset = 0;
		this.state.help = false;
		this.state.form = null;
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
			this.state.nextCursor = page.nextCursor;
			this.state.status = page.entries.length ? "ready" : "empty";
		} catch (error) {
			if (this.active(epoch)) this.failed(error);
		}
		if (this.active(epoch)) this.changed();
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
		this.state.form = { target, title: "", due: "", field: "title" };
		this.state.error = null;
	}
	private async plan(): Promise<void> {
		const form = this.state.form;
		if (!form?.title.trim()) return;
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
			this.state.review = {
				kind: "create",
				task: proposal.task,
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
		this.state.review = {
			kind: "complete",
			requestId: this.uuid(),
			uncertain: false,
			task: { id: selected.id, listId: task.listId, dueAt: task.dueAt },
			title: selected.label,
			recurring: typeof task.rrule === "string",
		};
		this.state.status = "review";
		this.state.error = null;
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
			(this.state.detail || this.state.review || this.state.help) &&
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
		const form = this.state.form;
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
			if (input.type === "text" && input.text === "y") await this.write();
			else if (
				input.type === "key" &&
				input.key === "escape" &&
				!this.state.review.uncertain
			) {
				this.state.review = null;
				this.state.status = "ready";
			} else if (input.type === "text" && input.text === "q") {
				this.close();
				this.quit();
			}
			this.changed();
			return;
		}
		if (input.type === "paste") return;
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
				if (this.state.detail) this.state.detail = null;
				else await this.open(this.stack.pop() ?? null);
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
						this.stack.push(this.state.location);
						await this.open(
							this.state.location.resource === "workspaces"
								? { resource: "lists", workspaceId: selected.id }
								: { resource: "tasks", listId: selected.id },
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
