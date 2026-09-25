import { useQuery, useZero } from "@rocicorp/zero/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortableExportV1 } from "../../../domain/portability/v1.ts";
import { randomId } from "../../../domain/random-id.ts";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import { ImportApplyPanel } from "./ImportApplyPanel.tsx";

type Status = {
	id: string;
	planDigest: string;
	sourceId: string;
	sourceLabel: string;
	createdAt: string;
	report: {
		plannerVersion: 1 | 2 | 3 | 4;
		applySupported: boolean;
		counts: { ensure: number; ignored: number; blocked: number };
		findings: { code: string; path: string }[];
	};
};
type Source = { id: string; label: string; jobs: Status[] };
type Loaded = { text: string; document: PortableExportV1 };
const control = "mt-1 block w-full rounded-md border bg-background p-2 text-sm";

export function ImportPlanPanel() {
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const confirm = useConfirm();
	const active = useRef<AbortController | null>(null);
	const worker = useRef<Worker | null>(null);
	const mounted = useRef(true);
	const [sources, setSources] = useState<Source[]>([]);
	const [source, setSource] = useState("");
	const [newId, setNewId] = useState(() => randomId());
	const [label, setLabel] = useState("");
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [workspaceMap, setWorkspaceMap] = useState<Record<string, string>>({});
	const [principalMap, setPrincipalMap] = useState<
		Record<string, string | null>
	>({});
	const [report, setReport] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	const [applying, setApplying] = useState(false);
	const locked = busy || applying;
	const [parsing, setParsing] = useState(false);
	const [error, setError] = useState<
		| "failed"
		| "invalid"
		| "unsupported"
		| "limit"
		| "quota"
		| "retained"
		| "incomplete"
		| null
	>(null);
	const writable = workspaces.filter((w) =>
		memberships.some(
			(row) =>
				row.workspaceId === w.id &&
				row.userId === zero.userID &&
				WRITE_ROLES.has(row.role as Role),
		),
	);
	const selectedTargets = new Set(Object.values(workspaceMap));
	const people = [
		...new Map(
			memberships
				.filter((row) => selectedTargets.has(row.workspaceId) && row.user)
				.map((row) => [
					row.userId,
					{ id: row.userId, name: row.user?.name ?? row.userId },
				]),
		).values(),
	];

	const refresh = useCallback(async (signal: AbortSignal) => {
		const response = await fetch("/api/portability/import/sources", {
			signal,
			credentials: "same-origin",
			cache: "no-store",
		});
		if (!response.ok) throw new Error("Sources unavailable");
		const body = (await response.json()) as { sources: Source[] };
		if (!signal.aborted) setSources(body.sources);
	}, []);
	useEffect(() => {
		mounted.current = true;
		const controller = new AbortController();
		void refresh(controller.signal).catch(() => {
			if (!controller.signal.aborted) setError("failed");
		});
		return () => {
			mounted.current = false;
			controller.abort();
			active.current?.abort();
			worker.current?.terminate();
		};
	}, [refresh]);
	function changed() {
		setReport(null);
		setError(null);
	}
	function selectFile(file: File | undefined) {
		worker.current?.terminate();
		worker.current = null;
		changed();
		setLoaded(null);
		setWorkspaceMap({});
		setPrincipalMap({});
		setParsing(false);
		if (!file) return;
		if (file.size > 32 * 1024 * 1024) {
			setError("limit");
			return;
		}
		setParsing(true);
		const parser = new Worker(
			new URL("./import-plan.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.current = parser;
		parser.onmessage = (
			event: MessageEvent<
				Loaded | { error: "invalid" | "limit" | "unsupported" }
			>,
		) => {
			if (worker.current !== parser) return;
			setParsing(false);
			parser.terminate();
			worker.current = null;
			if ("error" in event.data) {
				setError(event.data.error);
				return;
			}
			const result = event.data;
			setLoaded(result);
			setPrincipalMap(
				Object.fromEntries(
					result.document.data.principals.map((p) => [
						p.id,
						p.id === result.document.sourceUserId
							? (zero.userID ?? null)
							: null,
					]),
				),
			);
		};
		parser.onerror = () => {
			if (worker.current === parser) {
				setParsing(false);
				setError("invalid");
				parser.terminate();
				worker.current = null;
			}
		};
		parser.postMessage(file);
	}
	async function request(path: string, body?: unknown) {
		if (active.current || applying) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/portability/import/${path}`, {
				method: "POST",
				credentials: "same-origin",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			if (!response.ok) {
				const failure: unknown = await response.json().catch(() => null);
				const code =
					failure && typeof failure === "object" && "code" in failure
						? failure.code
						: null;
				if (!controller.signal.aborted)
					setError(
						code === "unsupported-import-version"
							? "unsupported"
							: code === "import-source-retained"
								? "retained"
								: code === "import-run-incomplete"
									? "incomplete"
									: code === "import-quota-exceeded"
										? "quota"
										: response.status === 413
											? "limit"
											: "failed",
					);
				return;
			}
			if (path === "plans") {
				const result = (await response.json()) as Status;
				if (!controller.signal.aborted) {
					setReport(result);
					setSource(result.sourceId);
					setNewId(randomId());
				}
			} else if (!controller.signal.aborted) setReport(null);
			await refresh(controller.signal);
			return true;
		} catch {
			if (!controller.signal.aborted) setError("failed");
		} finally {
			if (active.current === controller) {
				active.current = null;
				if (mounted.current) setBusy(false);
			}
		}
	}
	async function discard(kind: "sources" | "plans", id: string) {
		if (locked) return;
		const ok = await confirm({
			body: m.import_plan_discard_body(),
			confirmLabel: m.import_plan_discard(),
			destructive: true,
		});
		if (!ok || !mounted.current) return;
		const discarded = await request(
			`${kind}/${encodeURIComponent(id)}/discard`,
		);
		if (discarded && kind === "sources" && source === id) {
			setSource("");
			setNewId(randomId());
		}
	}
	const ready =
		loaded?.document.data.workspaces.every((w) =>
			writable.some((target) => target.id === workspaceMap[w.id]),
		) &&
		(source || label.trim());
	const applicable =
		report?.report.applySupported &&
		(report.report.plannerVersion === 2 ||
			report.report.plannerVersion === 3 ||
			report.report.plannerVersion === 4);
	return (
		<section
			id="import-plan"
			className="mt-8 border-t pt-4"
			aria-labelledby="import-plan-heading"
		>
			<h2 id="import-plan-heading" className="text-sm font-semibold">
				{m.import_plan_heading()}
			</h2>
			<p className="mt-2 text-sm text-muted-foreground">
				{m.import_apply_intro()}
			</p>
			<fieldset disabled={locked} className="mt-3 space-y-3">
				<label className="block text-sm">
					{m.import_plan_file()}
					<input
						type="file"
						accept="application/json,.json"
						className={control}
						onChange={(e) => selectFile(e.target.files?.[0])}
					/>
				</label>
				<p className="text-xs text-muted-foreground">
					{m.import_plan_limits()}
				</p>
				<label className="block text-sm">
					{m.import_plan_source()}
					<select
						className={control}
						value={source}
						onChange={(e) => {
							if (source && !e.target.value) setNewId(randomId());
							setSource(e.target.value);
							changed();
						}}
					>
						<option value="">{m.import_plan_new()}</option>
						{sources.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				{!source && (
					<label className="block text-sm">
						{m.import_plan_label()}
						<input
							maxLength={100}
							className={control}
							value={label}
							onChange={(e) => {
								setNewId(randomId());
								setLabel(e.target.value);
								changed();
							}}
						/>
					</label>
				)}
				<p className="text-xs text-muted-foreground">
					{m.import_plan_identity()}
				</p>
				{loaded && (
					<>
						<h3 className="text-sm font-medium">
							{m.import_plan_workspaces()}
						</h3>
						{loaded.document.data.workspaces.map((w) => (
							<label key={w.id} className="block text-sm">
								{w.name}
								<select
									data-testid="import-workspace"
									className={control}
									value={workspaceMap[w.id] ?? ""}
									onChange={(e) => {
										setWorkspaceMap({
											...workspaceMap,
											[w.id]: e.target.value,
										});
										setPrincipalMap(
											Object.fromEntries(
												loaded.document.data.principals.map((p) => [
													p.id,
													p.id === loaded.document.sourceUserId
														? (zero.userID ?? null)
														: null,
												]),
											),
										);
										changed();
									}}
								>
									<option value="">{m.import_plan_choose()}</option>
									{writable.map((target) => (
										<option key={target.id} value={target.id}>
											{target.name}
										</option>
									))}
								</select>
							</label>
						))}
						<h3 className="text-sm font-medium">{m.import_plan_people()}</h3>
						<p className="text-xs text-muted-foreground">
							{m.import_plan_people_help()}{" "}
							{m.import_plan_assignment_membership()}
						</p>
						{loaded.document.data.principals.map((p) => (
							<label key={p.id} className="block text-sm">
								{p.name}
								<select
									className={control}
									disabled={p.id === loaded.document.sourceUserId}
									value={principalMap[p.id] ?? ""}
									onChange={(e) => {
										setPrincipalMap({
											...principalMap,
											[p.id]: e.target.value || null,
										});
										changed();
									}}
								>
									<option value="">{m.import_plan_unmapped()}</option>
									{p.id === loaded.document.sourceUserId ? (
										<option value={zero.userID}>{m.import_plan_you()}</option>
									) : (
										people.map((person) => (
											<option key={person.id} value={person.id}>
												{person.name}
											</option>
										))
									)}
								</select>
							</label>
						))}
					</>
				)}
				<Button
					disabled={!ready || parsing}
					onClick={() => {
						if (loaded)
							void request("plans", {
								source: source
									? { mode: "existing", id: source }
									: { mode: "new", id: newId, label: label.trim() },
								document: loaded.text,
								mappings: {
									workspaces: workspaceMap,
									principals: principalMap,
								},
							});
					}}
				>
					{busy || parsing ? m.import_plan_busy() : m.import_plan_save()}
				</Button>
			</fieldset>
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error === "unsupported"
						? m.import_plan_history_unsupported()
						: error === "retained"
							? m.import_apply_source_retained()
							: error === "incomplete"
								? m.import_apply_run_active()
								: error === "quota"
									? m.import_plan_quota()
									: error === "limit"
										? m.import_plan_limits()
										: error === "invalid"
											? m.import_plan_invalid()
											: m.import_plan_failed()}
				</p>
			)}
			{report && (
				<div role="status" className="mt-4 rounded-md border p-3">
					<h3 className="font-medium">
						{applicable ? m.import_apply_report() : m.import_plan_report()}
					</h3>
					<p className="text-sm">
						{applicable
							? report.report.plannerVersion === 4
								? m.import_apply_boundary_activation()
								: report.report.plannerVersion === 3
									? m.import_apply_boundary_assignments()
									: m.import_apply_boundary()
							: m.import_plan_boundary()}
					</p>
					<dl className="mt-2 text-sm">
						{(
							[
								[
									"ensure",
									applicable
										? m.import_apply_eligible()
										: m.import_plan_ensure(),
								],
								["ignored", m.import_plan_ignored()],
								["blocked", m.import_plan_blocked()],
							] as const
						).map(([key, name]) => (
							<div key={key} className="flex justify-between gap-4">
								<dt>{name}</dt>
								<dd>
									{new Intl.NumberFormat(getLocale()).format(
										report.report.counts[key],
									)}
								</dd>
							</div>
						))}
					</dl>
					<p className="mt-2 text-xs text-muted-foreground">
						{applicable
							? m.import_apply_retention()
							: m.import_plan_report_help()}
					</p>
					{report.report.findings.length > 0 && (
						<details className="mt-2 text-xs">
							<summary>{m.import_plan_details()}</summary>
							<ul>
								{report.report.findings.map((f) => (
									<li key={`${f.code}-${f.path}`} className="break-all">
										{f.code}: {f.path}
									</li>
								))}
							</ul>
						</details>
					)}
				</div>
			)}
			{report && applicable && (
				<ImportApplyPanel
					key={report.id}
					plan={report}
					onBusy={setApplying}
					disabled={busy}
				/>
			)}
			<h3 className="mt-5 text-sm font-medium">{m.import_plan_saved()}</h3>
			{sources.map((s) => (
				<div key={s.id} className="mt-2 rounded-md border p-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span>{s.label}</span>
						<Button
							variant="outline"
							disabled={locked}
							onClick={() => void discard("sources", s.id)}
						>
							{m.import_plan_discard_source()}
						</Button>
					</div>
					{s.jobs.map((job) => (
						<div
							key={job.id}
							className="mt-2 flex flex-wrap items-center gap-2"
						>
							<Button
								variant="outline"
								disabled={locked}
								onClick={() => {
									setReport(job);
									setError(null);
								}}
							>
								{new Intl.DateTimeFormat(getLocale(), {
									dateStyle: "short",
									timeStyle: "short",
								}).format(new Date(job.createdAt))}
							</Button>
							<Button
								variant="outline"
								disabled={locked}
								onClick={() => void discard("plans", job.id)}
							>
								{m.import_plan_discard()}
							</Button>
						</div>
					))}
				</div>
			))}
		</section>
	);
}
