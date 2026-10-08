import { useQuery, useZero } from "@rocicorp/zero/react";
import { FileUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ATTACHMENT_ARCHIVE_LIMITS } from "../../../domain/portability/attachment-archive.ts";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import {
	type AttachmentImportState,
	createAttachmentImportController,
} from "../../lib/e2e/attachment-import-controller.ts";
import type {
	MigrationBinding,
	MigrationParentPage,
} from "../../lib/e2e/attachment-migration-api.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { browserE2eRuntime } from "../../lib/e2e/runtime.ts";
import { UnlockDialog } from "../e2e/UnlockDialog.tsx";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { FilePicker } from "../ui/file-picker.tsx";
import { Input } from "../ui/input.tsx";

type Controller = ReturnType<typeof createAttachmentImportController>;
const controlClass =
	"h-auto min-h-8 max-w-full whitespace-normal py-1.5 pointer-coarse:min-h-11";
async function readFile(file: File, signal: AbortSignal): Promise<string> {
	if (file.size > ATTACHMENT_ARCHIVE_LIMITS.serializedBytes)
		throw new Error("file-limit");
	const reader = file.stream().getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) {
				complete = true;
				break;
			}
			total += chunk.value.byteLength;
			if (total > ATTACHMENT_ARCHIVE_LIMITS.serializedBytes)
				throw new Error("file-limit");
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
function BoundedFilePicker({
	label,
	fileName,
	disabled,
	onFile,
	onNativePick,
	error,
}: {
	label: string;
	fileName: string | null;
	disabled: boolean;
	onFile: (file: File | undefined) => void;
	onNativePick?: () => void;
	error?: string;
}) {
	const id = useId();
	if (onNativePick)
		return (
			<div className="flex flex-col gap-1 text-sm">
				<label id={`${id}-label`} htmlFor={id} className="font-medium">
					{label}
				</label>
				<div className="flex min-w-0 flex-wrap items-center gap-3">
					<Button
						id={id}
						type="button"
						variant="outline"
						className="pointer-coarse:min-h-11 dark:aria-invalid:border-destructive aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:text-foreground aria-disabled:hover:bg-muted aria-disabled:active:translate-y-0"
						aria-disabled={disabled}
						aria-labelledby={`${id}-label ${id}`}
						aria-invalid={!!error}
						aria-describedby={error ? `${id}-name ${id}-error` : `${id}-name`}
						onClick={() => {
							if (!disabled) onNativePick();
						}}
					>
						<FileUp />
						{m.file_picker_choose()}
					</Button>
					<span id={`${id}-name`} className="min-w-0 break-all">
						<bdi>{fileName ?? m.file_picker_none()}</bdi>
					</span>
				</div>
				{error && (
					<p
						id={`${id}-error`}
						role="alert"
						className="text-sm text-destructive"
					>
						{error}
					</p>
				)}
			</div>
		);
	return (
		<FilePicker
			label={label}
			fileName={fileName}
			disabled={disabled}
			accept="application/json,.json"
			onFile={onFile}
		/>
	);
}
const blockedLabels = {
	"uncommitted-source": () => m.archive_import_blocked_source(),
	"parent-unapplied": () => m.archive_import_blocked_mapping(),
	"workspace-mismatch": () => m.archive_import_blocked_mapping(),
	"parent-unavailable": () => m.archive_import_blocked_parent(),
	"parent-changed": () => m.archive_import_blocked_parent(),
	"not-permitted": () => m.archive_import_blocked_permission(),
	"historical-proof-unavailable": () => m.archive_import_blocked_history(),
};

export function AttachmentArchiveImportDialog({
	binding,
	exactContentDocument,
	onClose,
}: {
	binding: MigrationBinding;
	exactContentDocument?: string;
	onClose: () => void;
}) {
	const zero = useZero<typeof schema>();
	const [lists] = useQuery(queries.lists.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const [comments] = useQuery(queries.comments.mine());
	const keys = useKeyring();
	const [capturedRuntime] = useState(() => ({
		runtime: keys.runtime,
		input: keys.runtime.attachments?.archiveInput,
		migration: keys.runtime.attachments?.archiveMigration,
	}));
	const keysRef = useRef(keys);
	keysRef.current = keys;
	const [capturedBinding] = useState(() => Object.freeze({ ...binding }));
	const alive = useRef(true);
	const scope = useRef(new AbortController());
	const initialZero = useRef(zero);
	const controller = useRef<Controller | null>(null);
	const pickers = useRef<{
		content?: AbortController;
		archive?: AbortController;
	}>({});
	const [content, setContent] = useState(exactContentDocument ?? "");
	const [archive, setArchive] = useState("");
	const [sourceNames, setSourceNames] = useState<ReadonlyMap<string, string>>(
		new Map(),
	);
	const [contentName, setContentName] = useState<string | null>(null);
	const [archiveName, setArchiveName] = useState<string | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [unlocking, setUnlocking] = useState(false);
	const [busy, setBusy] = useState(false);
	const flight = useRef<object | null>(null);
	const [reading, setReading] = useState(0);
	const [failed, setFailed] = useState(false);
	const [emptyFile, setEmptyFile] = useState<"content" | "archive" | null>(
		null,
	);
	const [state, setState] = useState<AttachmentImportState>({
		stage: "idle",
		ordinal: null,
		code: null,
		reservation: null,
		inspection: null,
	});
	const [parents, setParents] = useState<MigrationParentPage["items"]>([]);
	const [next, setNext] = useState<number | null>(-1);
	const [prepared, setPrepared] = useState(false);
	const [confirmRecovery, setConfirmRecovery] = useState(false);
	const [chosenOrdinal, setChosenOrdinal] = useState<number | null>(null);
	const status = useRef<HTMLParagraphElement | null>(null);
	const confirmButton = useRef<HTMLButtonElement | null>(null);
	const actionFocused = useRef(false);
	const id = useId();
	const selectedParent = parents.find(
		(parent) => parent.ordinal === chosenOrdinal,
	);
	const replacementBlockedReason =
		state.inspection?.attachmentState === "deleting"
			? m.archive_import_blocked_deleting()
			: selectedParent?.blockedReason
				? blockedLabels[selectedParent.blockedReason]()
				: null;
	const replacementBlocked = replacementBlockedReason !== null;
	const completed = state.stage === "complete";
	const selectedOrdinal = chosenOrdinal ?? state.ordinal;
	const browserOnly =
		capturedRuntime.runtime === browserE2eRuntime &&
		!capturedRuntime.runtime.attachments;
	function runtimeIsCurrent() {
		const runtime = keysRef.current.runtime;
		return (
			runtime === capturedRuntime.runtime &&
			(browserOnly
				? !runtime.attachments
				: !!capturedRuntime.input &&
					!!capturedRuntime.migration &&
					runtime.attachments?.archiveInput === capturedRuntime.input &&
					runtime.attachments?.archiveMigration === capturedRuntime.migration)
		);
	}
	const runtimeAvailable = runtimeIsCurrent();
	const unlocked = keys.ready && keys.state === "ready";
	const openBlockedReason = busy
		? m.archive_import_working()
		: reading > 0
			? m.archive_import_reading()
			: !content
				? m.archive_import_need_content()
				: !archive
					? m.archive_import_need_archive()
					: !passphrase
						? m.archive_import_need_passphrase()
						: null;
	const opened =
		!["idle", "opening", "retired"].includes(state.stage) && parents.length > 0;
	useEffect(() => {
		if (confirmRecovery) confirmButton.current?.focus();
	}, [confirmRecovery]);
	useEffect(() => {
		alive.current = true;
		scope.current = new AbortController();
		if (
			zero !== initialZero.current ||
			zero.userID !== capturedBinding.ownerId
		) {
			scope.current.abort();
			setChosenOrdinal(null);
			setState({
				stage: "retired",
				ordinal: null,
				code: "retired",
				reservation: null,
				inspection: null,
			});
		}
		return () => {
			alive.current = false;
			scope.current.abort();
			pickers.current.content?.abort();
			pickers.current.archive?.abort();
			controller.current?.dispose();
		};
	}, [zero, capturedBinding.ownerId]);
	useEffect(() => {
		if (unlocked && runtimeAvailable) return;
		if (
			!controller.current &&
			!pickers.current.content &&
			!pickers.current.archive
		)
			return;
		scope.current.abort();
		pickers.current.content?.abort();
		pickers.current.archive?.abort();
		controller.current?.dispose();
		flight.current = null;
		setBusy(false);
		setPassphrase("");
		setArchive("");
		setContent("");
		setContentName(null);
		setArchiveName(null);
		setConfirmRecovery(false);
		setSourceNames(new Map());
		setParents([]);
		setPrepared(false);
		setChosenOrdinal(null);
		setFailed(false);
		setEmptyFile(null);
		setState({
			stage: "retired",
			ordinal: null,
			code: "locked",
			reservation: null,
			inspection: null,
		});
	}, [unlocked, runtimeAvailable]);
	function checkpoint() {
		if (
			!alive.current ||
			scope.current.signal.aborted ||
			zero !== initialZero.current ||
			zero.userID !== capturedBinding.ownerId ||
			!runtimeIsCurrent() ||
			!keysRef.current.ready ||
			keysRef.current.state !== "ready"
		)
			throw new Error("retired");
	}
	async function pick(kind: "content" | "archive", file: File | undefined) {
		pickers.current[kind]?.abort();
		if (!file) return;
		const abort = new AbortController();
		pickers.current[kind] = abort;
		setReading((n) => n + 1);
		setFailed(false);
		setEmptyFile(null);
		if (kind === "content") {
			setContent("");
			setContentName(null);
		} else {
			setArchive("");
			setArchiveName(null);
		}
		try {
			const text = await readFile(file, abort.signal);
			checkpoint();
			if (abort.signal.aborted) return;
			if (kind === "content") {
				setContent(text);
				setContentName(file.name);
			} else {
				setArchive(text);
				setArchiveName(file.name);
			}
		} catch {
			if (alive.current && !abort.signal.aborted) setFailed(true);
		} finally {
			if (alive.current) setReading((n) => n - 1);
		}
	}
	async function pickNative(kind: "content" | "archive") {
		if (browserOnly || flight.current || reading || !unlocked) return;
		const input = capturedRuntime.input;
		if (!input) return;
		pickers.current[kind]?.abort();
		const abort = new AbortController();
		pickers.current[kind] = abort;
		setReading((n) => n + 1);
		setFailed(false);
		setEmptyFile(null);
		try {
			checkpoint();
			const selected = await input.readDocument(kind, abort.signal);
			checkpoint();
			if (abort.signal.aborted || pickers.current[kind] !== abort || !selected)
				return;
			if (!selected.text.trim()) {
				setEmptyFile(kind);
				return;
			}
			if (kind === "content") {
				setContent(selected.text);
				setContentName(selected.name);
			} else {
				setArchive(selected.text);
				setArchiveName(selected.name);
			}
		} catch {
			if (alive.current && !abort.signal.aborted && runtimeIsCurrent())
				setFailed(true);
		} finally {
			if (alive.current) setReading((n) => n - 1);
		}
	}
	async function run(operation: (value: Controller) => Promise<unknown>) {
		if (flight.current || reading || !unlocked || !runtimeAvailable) return;
		const currentFlight = {};
		flight.current = currentFlight;
		setBusy(true);
		setFailed(false);
		setEmptyFile(null);
		actionFocused.current = document.activeElement?.tagName === "BUTTON";
		try {
			checkpoint();
			controller.current ??= createAttachmentImportController({
				binding: capturedBinding,
				ownerId: capturedBinding.ownerId,
				zero,
				keyring: () => keysRef.current,
				checkpoint,
				signal: scope.current.signal,
				onState: (value) => {
					if (alive.current && !scope.current.signal.aborted) {
						if (value.stage === "retired") {
							setChosenOrdinal(null);
							setConfirmRecovery(false);
							setPrepared(false);
						}
						setPrepared(controller.current?.hasPrepared ?? false);
						setState(value);
					}
				},
			});
			await operation(controller.current);
			checkpoint();
			setParents(controller.current.parents);
		} catch {
			if (alive.current && !scope.current.signal.aborted) setFailed(true);
		} finally {
			if (flight.current === currentFlight) {
				flight.current = null;
				if (alive.current) {
					setBusy(false);
					if (actionFocused.current && document.activeElement === document.body)
						status.current?.focus();
				}
			}
		}
	}
	async function page(value: Controller) {
		if (next === null) return;
		const result = await value.discoverPage({ afterOrdinal: next, limit: 64 });
		checkpoint();
		setNext(result.nextAfterOrdinal);
	}
	function destinationTitle(parent: MigrationParentPage["items"][number]) {
		const destination = parent.destinationParent;
		if (!destination) return "";
		if (destination.kind === "list")
			return (
				lists.find((item) => item.id === destination.id)?.title ??
				destination.id
			);
		const taskId =
			destination.kind === "comment"
				? comments.find((item) => item.id === destination.id)?.taskId
				: destination.id;
		return tasks.find((item) => item.id === taskId)?.title ?? destination.id;
	}
	function close() {
		controller.current?.cancel();
		controller.current?.dispose();
		scope.current.abort();
		pickers.current.content?.abort();
		pickers.current.archive?.abort();
		setPassphrase("");
		setContent("");
		setArchive("");
		setSourceNames(new Map());
		setChosenOrdinal(null);
		onClose();
	}
	const liveStatus =
		state.stage === "retired"
			? m.archive_import_reopen()
			: state.stage === "complete"
				? m.archive_import_complete()
				: state.stage === "uncertain"
					? m.archive_import_uncertain()
					: state.stage === "recovery-required"
						? !state.inspection
							? m.archive_import_recovery()
							: (replacementBlockedReason ??
								(state.inspection.recoverable
									? m.archive_import_recovery_ended()
									: m.archive_import_recovery_live()))
						: busy
							? m.archive_import_working()
							: state.stage === "prepared"
								? m.archive_import_prepared()
								: state.stage === "cancelled"
									? m.archive_import_cancelled()
									: m.archive_import_status();
	return (
		<>
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) close();
				}}
			>
				<DialogContent
					className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
					{...(completed ? { "aria-describedby": undefined } : {})}
					data-testid="attachment-archive-import-dialog"
				>
					<DialogHeader>
						<DialogTitle>{m.archive_import_action()}</DialogTitle>
					</DialogHeader>
					<p
						ref={status}
						tabIndex={-1}
						role="status"
						aria-live="polite"
						className="text-sm font-medium"
					>
						{reading > 0 ? m.archive_import_reading() : liveStatus}
					</p>
					{!completed && (
						<>
							<DialogDescription>
								{m.archive_import_description()}
							</DialogDescription>
							<p className="text-sm text-muted-foreground">
								{m.archive_import_cancel_note()}
							</p>
						</>
					)}
					{!runtimeAvailable ? (
						<p>{m.archive_export_browser_only()}</p>
					) : !unlocked ? (
						<div className="space-y-2">
							<p>{m.archive_export_locked()}</p>
							{keys.state === "locked" && (
								<Button
									className={controlClass}
									onClick={() => setUnlocking(true)}
								>
									{m.e2e_unlock_submit()}
								</Button>
							)}
						</div>
					) : (
						<>
							{state.stage === "idle" && (
								<>
									{!exactContentDocument && (
										<BoundedFilePicker
											label={m.archive_import_content_file()}
											fileName={contentName}
											error={
												emptyFile === "content"
													? m.archive_import_empty_file()
													: undefined
											}
											disabled={busy || (!browserOnly && reading > 0)}
											onFile={(file) => void pick("content", file)}
											onNativePick={
												browserOnly
													? undefined
													: () => void pickNative("content")
											}
										/>
									)}
									<BoundedFilePicker
										label={m.archive_import_archive_file()}
										fileName={archiveName}
										error={
											emptyFile === "archive"
												? m.archive_import_empty_file()
												: undefined
										}
										disabled={busy || (!browserOnly && reading > 0)}
										onFile={(file) => void pick("archive", file)}
										onNativePick={
											browserOnly ? undefined : () => void pickNative("archive")
										}
									/>
									<p className="text-xs text-muted-foreground">
										{m.archive_import_limits()}
									</p>
									<label
										htmlFor={`${id}-passphrase`}
										className="text-sm font-medium"
									>
										{m.archive_import_passphrase()}
									</label>
									<Input
										id={`${id}-passphrase`}
										type="password"
										autoComplete="off"
										maxLength={1024}
										className="pointer-coarse:min-h-11"
										value={passphrase}
										disabled={busy}
										onChange={(event) => setPassphrase(event.target.value)}
										aria-describedby={`${id}-secret-note`}
									/>
									<p
										id={`${id}-secret-note`}
										className="text-sm text-muted-foreground"
									>
										{m.archive_import_secret_note()}
									</p>
									<Button
										className={controlClass}
										aria-describedby={
											openBlockedReason ? `${id}-open-blocked` : undefined
										}
										disabled={
											busy || reading > 0 || !content || !archive || !passphrase
										}
										onClick={() =>
											void run(async (value) => {
												try {
													await value.open(archive, content, passphrase);
													const sources = await value.describeArchiveSources();
													checkpoint();
													setSourceNames(
														new Map(
															sources.map((source) => [
																source.sourceId,
																source.filename,
															]),
														),
													);
													await page(value);
												} finally {
													setPassphrase("");
												}
											})
										}
									>
										{m.archive_import_open()}
									</Button>
									{openBlockedReason && (
										<p
											id={`${id}-open-blocked`}
											className="text-sm text-muted-foreground"
										>
											{openBlockedReason}
										</p>
									)}
								</>
							)}
							{(state.stage === "error" || state.stage === "retired") &&
								!prepared && <p>{m.archive_import_reopen()}</p>}
							{parents.length > 0 && (
								<fieldset>
									<legend
										className={
											!prepared && !completed
												? "text-sm font-medium"
												: "sr-only"
										}
									>
										{m.archive_import_choose()}
									</legend>
									<ul className="max-h-64 overflow-y-auto">
										{parents.map((parent) => (
											<li
												key={parent.ordinal}
												className="border-b py-2 last:border-0"
											>
												<label className="flex min-h-11 items-center gap-3 text-sm">
													<input
														type="radio"
														name={`${id}-parent`}
														className="size-4 shrink-0 accent-primary"
														checked={
															(prepared || completed
																? selectedOrdinal
																: state.ordinal) === parent.ordinal
														}
														disabled={
															busy ||
															(completed &&
																parent.ordinal === selectedOrdinal) ||
															prepared ||
															!parent.destinationParent ||
															!controller.current?.archiveSourceIds.includes(
																parent.sourceAttachmentId,
															)
														}
														onChange={() => {
															try {
																if (!controller.current) return;
																controller.current.select(parent.ordinal);
																void run((value) => value.inspect());
																setConfirmRecovery(false);
																setChosenOrdinal(parent.ordinal);
																setFailed(false);
																setEmptyFile(null);
															} catch {
																setFailed(true);
															}
														}}
													/>
													<span className="min-w-0 break-all">
														{sourceNames.get(parent.sourceAttachmentId) ??
															parent.sourceAttachmentId}
														<br />
														{m.archive_import_destination_reference()}{" "}
														{destinationTitle(parent)}
														<span className="block text-xs text-muted-foreground">
															{m.archive_import_source_reference()}{" "}
															{parent.sourceAttachmentId}
														</span>
													</span>
												</label>
												{(parent.blockedReason ||
													!controller.current?.archiveSourceIds.includes(
														parent.sourceAttachmentId,
													)) && (
													<p className="text-xs text-muted-foreground">
														{parent.blockedReason
															? blockedLabels[parent.blockedReason]()
															: m.archive_import_blocked_archive()}
													</p>
												)}
											</li>
										))}
									</ul>
								</fieldset>
							)}
							{opened && next !== null && !prepared && (
								<Button
									className={controlClass}
									variant="outline"
									disabled={busy}
									onClick={() => void run(page)}
								>
									{m.archive_import_more()}
								</Button>
							)}
							{state.stage === "selected" && (
								<Button
									className={controlClass}
									disabled={busy || !!selectedParent?.blockedReason}
									onClick={() =>
										void run(async (value) => {
											const result = await value.prepare();
											checkpoint();
											setPrepared(result !== null);
										})
									}
								>
									{m.archive_import_prepare()}
								</Button>
							)}
							{state.stage === "recovery-required" && !state.inspection && (
								<Button
									className={controlClass}
									disabled={busy}
									onClick={() => void run((value) => value.inspect())}
								>
									{m.archive_import_reconcile()}
								</Button>
							)}
							{state.stage === "recovery-required" && state.inspection && (
								<div className="space-y-2">
									<p className="text-sm">{m.archive_import_recovery_note()}</p>
									{replacementBlockedReason && (
										<p id={`${id}-replacement-blocked`} className="text-sm">
											{replacementBlockedReason}
										</p>
									)}
									{!confirmRecovery ? (
										<Button
											className={controlClass}
											disabled={busy || replacementBlocked}
											aria-describedby={
												replacementBlocked
													? `${id}-replacement-blocked`
													: undefined
											}
											onClick={() => setConfirmRecovery(true)}
										>
											{m.archive_import_replace()}
										</Button>
									) : (
										<>
											<p id={`${id}-replacement-risk`} className="text-sm">
												{m.archive_import_replace_confirmation()}
											</p>
											<Button
												ref={confirmButton}
												className={controlClass}
												disabled={busy || replacementBlocked}
												aria-describedby={`${id}-replacement-risk${replacementBlocked ? ` ${id}-replacement-blocked` : ""}`}
												onClick={() =>
													void run(async (value) => {
														setConfirmRecovery(false);
														await value.recover({ retireLive: true });
														setPrepared(value.hasPrepared);
													})
												}
											>
												{m.archive_import_replace_confirm()}
											</Button>
											<Button
												className={controlClass}
												variant="outline"
												disabled={busy}
												onClick={() => setConfirmRecovery(false)}
											>
												{m.confirm_cancel()}
											</Button>
										</>
									)}
								</div>
							)}
							{state.stage === "prepared" && (
								<Button
									className={controlClass}
									disabled={busy}
									onClick={() => void run((value) => value.transfer())}
								>
									{m.archive_import_transfer()}
								</Button>
							)}
							{state.ordinal !== null &&
								["uncertain", "error", "cancelled"].includes(state.stage) && (
									<div className="flex flex-wrap gap-2">
										<Button
											className={controlClass}
											disabled={busy}
											onClick={() => void run((value) => value.reconcile())}
										>
											{m.archive_import_reconcile()}
										</Button>
										{prepared && (
											<Button
												className={controlClass}
												variant="outline"
												disabled={busy}
												onClick={() => void run((value) => value.retry())}
											>
												{m.archive_import_retry()}
											</Button>
										)}
									</div>
								)}
							{prepared &&
								state.code === "active-reservation" &&
								state.reservation?.targetAttachmentId && (
									<Button
										className={controlClass}
										variant="outline"
										disabled={busy}
										onClick={() =>
											void run((value) => value.cancelReservation())
										}
									>
										{m.archive_import_cancel_reservation()}
									</Button>
								)}
							{busy && (
								<Button
									className={controlClass}
									variant="outline"
									onClick={() => controller.current?.cancel()}
								>
									{m.confirm_cancel()}
								</Button>
							)}
						</>
					)}
					{failed &&
						state.stage !== "uncertain" &&
						state.stage !== "recovery-required" && (
							<p role="alert" className="text-sm text-destructive">
								{m.archive_import_failed()}
							</p>
						)}
					<Button className={controlClass} variant="outline" onClick={close}>
						{m.action_close()}
					</Button>
				</DialogContent>
			</Dialog>
			{zero.userID && (
				<UnlockDialog
					open={unlocking}
					onOpenChange={setUnlocking}
					userId={zero.userID}
				/>
			)}
		</>
	);
}
