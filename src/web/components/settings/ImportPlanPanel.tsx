import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type {
	ProviderImportInput,
	ProviderInputBinding,
} from "../../../domain/portability/providers/input.ts";
import type { PortableExportV1 } from "../../../domain/portability/v1.ts";
import type { PortableExportV2 } from "../../../domain/portability/v2.ts";
import { randomId } from "../../../domain/random-id.ts";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import { FilePicker } from "../ui/file-picker.tsx";
import { Input } from "../ui/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { ImportApplyPanel } from "./ImportApplyPanel.tsx";

type Status = {
	id: string;
	planDigest: string;
	sourceId: string;
	sourceLabel: string;
	inputBinding?: ProviderInputBinding | null;
	createdAt: string;
	report: {
		plannerVersion: 1 | 2 | 3 | 4 | 5;
		applySupported: boolean;
		counts: { ensure: number; ignored: number; blocked: number };
		findings: { code: string; path: string }[];
	};
};
type Source = { id: string; label: string; jobs: Status[] };
type Loaded = {
	text?: string;
	input?: ProviderImportInput;
	document: PortableExportV1 | PortableExportV2;
};
// Radix Select reserves "" for "no value", so the empty choice needs a token.
const NONE = "__none";
const trigger = "w-full sm:w-72 pointer-coarse:data-[size=default]:h-11";

function Field({
	label,
	children,
}: {
	label: string;
	children: (labelId: string) => ReactNode;
}) {
	const labelId = useId();
	return (
		<div className="flex flex-col gap-1 text-sm">
			<span id={labelId} className="text-muted-foreground">
				{label}
			</span>
			{children(labelId)}
		</div>
	);
}

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
	const [format, setFormat] = useState<"native" | "csv" | "todoist">("native");
	const fileRef = useRef<File | undefined>(undefined);
	const [projectFolderName, setProjectFolderName] = useState("");
	const [unsectionedListName, setUnsectionedListName] = useState("");
	const [policyAccepted, setPolicyAccepted] = useState(false);
	const [fileName, setFileName] = useState<string | null>(null);
	const limitsId = useId();
	const labelInputId = useId();
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
		| "secure"
		| "binding"
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
		if (
			(loaded?.input ?? report?.inputBinding)?.adapter === "todoist-project-csv"
		)
			setPolicyAccepted(false);
		setReport(null);
		setError(null);
	}
	function selectFile(
		file: File | undefined,
		names = { projectFolderName, unsectionedListName },
	) {
		fileRef.current = file;
		worker.current?.terminate();
		worker.current = null;
		changed();
		setLoaded(null);
		setPolicyAccepted(false);
		setWorkspaceMap({});
		setPrincipalMap({});
		setParsing(false);
		setFileName(file?.name ?? null);
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
				Loaded | { error: "invalid" | "limit" | "unsupported" | "secure" }
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
		parser.postMessage({ file, format, ...names });
	}
	async function request(path: string, body?: unknown) {
		if (active.current || applying) return;
		const requestInput = loaded?.input;
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
						code === "source-binding-conflict" &&
							requestInput?.kind === "provider" &&
							requestInput.adapter === "todoist-project-csv"
							? "binding"
							: code === "unsupported-import-version"
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
	const displayedBinding = report?.inputBinding ?? loaded?.input;
	const todoistBinding =
		displayedBinding?.adapter === "todoist-project-csv"
			? displayedBinding
			: null;
	const ready =
		loaded?.document.data.workspaces.every((w) =>
			writable.some((target) => target.id === workspaceMap[w.id]),
		) &&
		(source || label.trim()) &&
		(!loaded.input || policyAccepted);
	const applicable =
		report?.report.applySupported &&
		(report.report.plannerVersion === 2 ||
			report.report.plannerVersion === 3 ||
			report.report.plannerVersion === 4 ||
			report.report.plannerVersion === 5);
	return (
		<section id="import-plan" aria-labelledby="import-plan-heading">
			<h3 id="import-plan-heading" className="text-sm font-semibold">
				{m.import_plan_heading()}
			</h3>
			<p className="mt-2 text-sm text-muted-foreground">
				{m.import_apply_intro()}
			</p>
			{(loaded?.input || report?.inputBinding) && (
				<div className="mt-3 space-y-2 text-sm">
					<p>
						{m.import_provider_namespace({
							namespace:
								(report?.inputBinding ?? loaded?.input)?.sourceNamespace ?? "",
						})}
					</p>
					{todoistBinding ? (
						<>
							<p className="break-all">
								{m.import_todoist_snapshot({
									digest: todoistBinding.snapshotSha256,
								})}
							</p>
							<p>
								{m.import_todoist_mapping({
									project: todoistBinding.projectFolderName,
									unsectioned: todoistBinding.unsectionedListName,
								})}
							</p>
							<p>{m.import_todoist_policy()}</p>
						</>
					) : (
						<p>{m.import_provider_policy()}</p>
					)}
					<label className="flex items-start gap-2">
						<input
							type="checkbox"
							data-testid="import-provider-policy"
							disabled={locked}
							checked={policyAccepted}
							onChange={(event) => {
								setPolicyAccepted(event.target.checked);
							}}
						/>
						{todoistBinding
							? m.import_todoist_acknowledge()
							: m.import_provider_acknowledge()}
					</label>
				</div>
			)}
			<fieldset disabled={locked} className="mt-3 min-w-0 space-y-3">
				<Field label={m.import_provider_format()}>
					{(labelId) => (
						<Select
							value={format}
							onValueChange={(next) => {
								if (next !== "native" && next !== "csv" && next !== "todoist")
									return;
								setFormat(next);
								selectFile(undefined);
							}}
						>
							<SelectTrigger
								aria-labelledby={labelId}
								data-testid="import-format"
								className={trigger}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="native">
									{m.import_provider_native()}
								</SelectItem>
								<SelectItem value="csv">{m.import_provider_csv()}</SelectItem>
								<SelectItem value="todoist">
									{m.import_todoist_format()}
								</SelectItem>
							</SelectContent>
						</Select>
					)}
				</Field>
				{format === "todoist" && (
					<>
						<Field label={m.import_todoist_project()}>
							{(labelId) => (
								<Input
									aria-labelledby={labelId}
									data-testid="import-todoist-project"
									className={trigger}
									maxLength={500}
									value={projectFolderName}
									onChange={(event) => {
										const value = event.target.value;
										setProjectFolderName(value);
										selectFile(fileRef.current, {
											projectFolderName: value,
											unsectionedListName,
										});
									}}
								/>
							)}
						</Field>
						<Field label={m.import_todoist_unsectioned()}>
							{(labelId) => (
								<Input
									aria-labelledby={labelId}
									data-testid="import-todoist-unsectioned"
									className={trigger}
									maxLength={500}
									value={unsectionedListName}
									onChange={(event) => {
										const value = event.target.value;
										setUnsectionedListName(value);
										selectFile(fileRef.current, {
											projectFolderName,
											unsectionedListName: value,
										});
									}}
								/>
							)}
						</Field>
						<p className="text-xs text-muted-foreground">
							{m.import_todoist_names_help()}
						</p>
					</>
				)}
				<FilePicker
					label={
						format === "todoist"
							? m.import_todoist_file()
							: format === "csv"
								? m.import_provider_file()
								: m.import_plan_file()
					}
					accept={
						format !== "native" ? "text/csv,.csv" : "application/json,.json"
					}
					fileName={fileName}
					disabled={locked}
					describedBy={limitsId}
					data-testid="import-file"
					onFile={(file) => selectFile(file)}
				/>
				<p id={limitsId} className="text-xs text-muted-foreground">
					{m.import_plan_limits()}
				</p>
				<Field label={m.import_plan_source()}>
					{(labelId) => (
						<Select
							disabled={locked}
							value={source || NONE}
							onValueChange={(next) => {
								const value = next === NONE ? "" : next;
								if (source && !value) setNewId(randomId());
								setSource(value);
								changed();
							}}
						>
							<SelectTrigger
								aria-labelledby={labelId}
								data-testid="import-source"
								className={trigger}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value={NONE}>{m.import_plan_new()}</SelectItem>
								{sources.map((s) => (
									<SelectItem key={s.id} value={s.id}>
										{s.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</Field>
				{!source && (
					<label htmlFor={labelInputId} className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">
							{m.import_plan_label()}
						</span>
						<Input
							id={labelInputId}
							maxLength={100}
							className="w-full sm:w-72 pointer-coarse:h-11"
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
						<h4 className="text-sm font-medium">
							{m.import_plan_workspaces()}
						</h4>
						{loaded.document.data.workspaces.map((w) => (
							<Field key={w.id} label={w.name}>
								{(labelId) => (
									<Select
										value={workspaceMap[w.id] || NONE}
										onValueChange={(next) => {
											setWorkspaceMap({
												...workspaceMap,
												[w.id]: next === NONE ? "" : next,
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
										<SelectTrigger
											aria-labelledby={labelId}
											data-testid="import-workspace"
											className={trigger}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											<SelectItem value={NONE}>
												{m.import_plan_choose()}
											</SelectItem>
											{writable.map((target) => (
												<SelectItem key={target.id} value={target.id}>
													{target.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
						))}
						<h4 className="text-sm font-medium">{m.import_plan_people()}</h4>
						<p className="text-xs text-muted-foreground">
							{m.import_plan_people_help()}{" "}
							{m.import_plan_assignment_membership()}
						</p>
						{loaded.document.data.principals.map((p) => (
							<Field key={p.id} label={p.name}>
								{(labelId) => (
									<Select
										disabled={p.id === loaded.document.sourceUserId}
										value={principalMap[p.id] || NONE}
										onValueChange={(next) => {
											setPrincipalMap({
												...principalMap,
												[p.id]: next === NONE ? null : next,
											});
											changed();
										}}
									>
										<SelectTrigger
											aria-labelledby={labelId}
											data-testid="import-principal"
											className={trigger}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper">
											<SelectItem value={NONE}>
												{m.import_plan_unmapped()}
											</SelectItem>
											{p.id === loaded.document.sourceUserId
												? zero.userID && (
														<SelectItem value={zero.userID}>
															{m.import_plan_you()}
														</SelectItem>
													)
												: people.map((person) => (
														<SelectItem key={person.id} value={person.id}>
															{person.name}
														</SelectItem>
													))}
										</SelectContent>
									</Select>
								)}
							</Field>
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
								...(loaded.input
									? { input: loaded.input }
									: { document: loaded.text }),
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
					{error === "secure"
						? m.import_todoist_secure_context()
						: error === "binding"
							? m.import_todoist_binding_conflict()
							: error === "unsupported"
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
													? format === "todoist"
														? m.import_todoist_invalid()
														: format === "csv"
															? m.import_provider_invalid()
															: m.import_plan_invalid()
													: m.import_plan_failed()}
				</p>
			)}
			{report && (
				<div role="status" className="mt-4 rounded-md border p-3">
					<h4 className="font-medium">
						{applicable ? m.import_apply_report() : m.import_plan_report()}
					</h4>
					<p className="text-sm">
						{applicable
							? report.report.plannerVersion >= 4
								? m.import_apply_boundary_activation()
								: report.report.plannerVersion === 3
									? m.import_apply_boundary_assignments()
									: m.import_apply_boundary()
							: report.report.plannerVersion === 5
								? m.import_history_preview_closed()
								: m.import_plan_boundary()}
					</p>
					{applicable && report.report.plannerVersion === 5 && (
						<p className="mt-2 text-sm">{m.import_apply_boundary_history()}</p>
					)}
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
					disabled={busy || (!!report.inputBinding && !policyAccepted)}
				/>
			)}
			<h4 className="mt-5 text-sm font-medium">{m.import_plan_saved()}</h4>
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
									worker.current?.terminate();
									worker.current = null;
									fileRef.current = undefined;
									setLoaded(null);
									setFileName(null);
									setParsing(false);
									setReport(job);
									setPolicyAccepted(false);
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
