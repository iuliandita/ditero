import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	ATTACHMENT_ARCHIVE_LIMITS,
	AttachmentArchiveContractError,
} from "../../../domain/portability/attachment-archive.ts";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { saveNativeArchiveDocument } from "../../lib/e2e/archive-export-save.ts";
import { createAttachmentExportController } from "../../lib/e2e/attachment-export-controller.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { supportsAttachmentArchiveExport } from "../../lib/e2e/runtime.ts";
import { useExportBoundary } from "../../lib/zero.tsx";
import { isZeroClientOwnerActive } from "../../lib/zero-lifecycle.ts";
import { UnlockDialog } from "../e2e/UnlockDialog.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";

type Controller = ReturnType<typeof createAttachmentExportController>;
type Source = Parameters<Controller["describe"]>[0];
type Pair = Awaited<ReturnType<Controller["exportSelected"]>>;
type Entry = { source: Source; filename: string | null };
type ExportError = "failed" | "pending" | "limit";
function exportError(error: unknown): ExportError {
	if (error instanceof Error && error.message === "pending-writes")
		return "pending";
	if (
		(error instanceof Error && error.message === "content-export-limit") ||
		(error instanceof AttachmentArchiveContractError &&
			error.code === "byte-limit")
	)
		return "limit";
	return "failed";
}

function filenameParts(filename: string) {
	let prefix = "";
	return filename.split("-").map((part) => {
		const separator = prefix ? "-" : "";
		prefix += separator + part;
		return (
			<Fragment key={prefix}>
				{separator && (
					<>
						-<wbr />
					</>
				)}
				{part}
			</Fragment>
		);
	});
}

const controlClass =
	"h-auto min-h-8 whitespace-normal py-1.5 pointer-coarse:min-h-11";

async function boundedContent(signal: AbortSignal): Promise<string> {
	const response = await fetch("/api/portability/export?version=2", {
		credentials: "same-origin",
		signal,
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(
			response.status === 413
				? "content-export-limit"
				: "content-export-failed",
		);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let complete = false;
	try {
		while (true) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) {
				complete = true;
				break;
			}
			bytes += chunk.value.byteLength;
			if (bytes > ATTACHMENT_ARCHIVE_LIMITS.serializedBytes)
				throw new Error("content-export-limit");
			chunks.push(chunk.value);
		}
		const result = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(result);
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export function AttachmentArchiveExportDialog({
	onClose,
}: {
	onClose: () => void;
}) {
	const zero = useZero<typeof schema>();
	const keyring = useKeyring();
	const keyringRef = useRef(keyring);
	keyringRef.current = keyring;
	const boundary = useExportBoundary();
	const [attachments, attachmentDetails] = useQuery(queries.attachments.mine());
	const queryDetails = useRef(attachmentDetails);
	queryDetails.current = attachmentDetails;
	const queryWake = useRef<(() => void) | null>(null);
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	const controller = useRef<Controller | null>(null);
	const pages = useRef<{
		sources: readonly Source[];
		offset: number;
		running: boolean;
		controller: Controller;
		signal: AbortSignal;
	} | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const prepareButton = useRef<HTMLButtonElement | null>(null);
	const contentButton = useRef<HTMLButtonElement | null>(null);
	const restorePreparedFocus = useRef(false);
	const active = useRef<AbortController | null>(null);
	const [unlocking, setUnlocking] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [passphrase, setPassphrase] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [stage, setStage] = useState<
		"loading" | "select" | "preparing" | "done"
	>("loading");
	const [error, setError] = useState<ExportError | null>(null);
	const [pair, setPair] = useState<Pair | null>(null);
	const [requested, setRequested] = useState({ content: false, files: false });
	const [progress, setProgress] = useState<
		"download" | "authenticate-and-seal" | null
	>(null);
	const id = useId();
	const supported = supportsAttachmentArchiveExport(keyring.runtime);
	const saving = useRef(false);
	const [savingFile, setSavingFile] = useState(false);
	const unlocked = keyring.ready && keyring.state === "ready";
	const sources = entries
		.filter((entry) => selected.includes(entry.source.id))
		.map((entry) => entry.source);
	let withinBounds = false;
	if (sources.length && controller.current && unlocked) {
		try {
			controller.current.preflightSelected(sources);
			withinBounds = true;
		} catch {
			/* The nearby bound explanation keeps Prepare unavailable. */
		}
	}

	useEffect(() => {
		if (attachmentDetails.type === "complete") queryWake.current?.();
	}, [attachmentDetails.type]);

	const loadPage = useCallback(
		async (page: NonNullable<typeof pages.current>) => {
			if (page.running) return;
			page.running = true;
			setLoadingMore(true);
			const check = () => {
				page.signal.throwIfAborted();
				if (
					pages.current !== page ||
					controller.current !== page.controller ||
					!isZeroClientOwnerActive(zero) ||
					!keyringRef.current.ready ||
					keyringRef.current.state !== "ready"
				)
					throw new Error("stale-export");
			};
			try {
				check();
				const batch = page.sources.slice(
					page.offset,
					page.offset + ATTACHMENT_ARCHIVE_LIMITS.entries,
				);
				const items: Entry[] = [];
				for (const source of batch) {
					try {
						const description = await page.controller.describe(source);
						check();
						items.push({ source, filename: description.filename });
					} catch {
						check();
						items.push({ source, filename: null });
					}
				}
				check();
				page.offset += batch.length;
				setEntries((current) => [...current, ...items]);
				setHasMore(page.offset < page.sources.length);
			} finally {
				page.running = false;
				if (pages.current === page && !page.signal.aborted)
					setLoadingMore(false);
			}
		},
		[zero],
	);
	async function loadMore() {
		const page = pages.current;
		if (!page || page.running || stage !== "select") return;
		setError(null);
		try {
			await loadPage(page);
		} catch (error) {
			if (!page.signal.aborted && pages.current === page)
				setError(exportError(error));
		}
	}

	useEffect(() => {
		const abort = new AbortController();
		active.current = abort;
		saving.current = false;
		setSavingFile(false);
		pages.current = null;
		setHasMore(false);
		setLoadingMore(false);
		setEntries([]);
		setSelected([]);
		setPair(null);
		setRequested({ content: false, files: false });
		setProgress(null);
		setPassphrase("");
		setConfirmation("");
		setError(null);
		setStage("loading");
		if (supported && unlocked)
			void (async () => {
				const saved = await boundary.waitForSaved({ signal: abort.signal });
				abort.signal.throwIfAborted();
				boundary.refreshJournal();
				const state = boundary.getSnapshot();
				if (
					!saved ||
					state.pending ||
					state.uncertain ||
					state.refused ||
					state.prior ||
					state.storageFailed
				)
					throw new Error("pending-writes");
				if (queryDetails.current.type !== "complete") {
					await new Promise<void>((resolve, reject) => {
						const done = () => {
							abort.signal.removeEventListener("abort", cancelled);
							if (queryWake.current === done) queryWake.current = null;
							resolve();
						};
						const cancelled = () => {
							if (queryWake.current === done) queryWake.current = null;
							reject(abort.signal.reason);
						};
						queryWake.current = done;
						abort.signal.addEventListener("abort", cancelled, { once: true });
						if (abort.signal.aborted) cancelled();
					});
				}
				abort.signal.throwIfAborted();
				const ownerId = zero.userID;
				if (!ownerId || !isZeroClientOwnerActive(zero))
					throw new Error("stale-export");
				const frozenSources: Source[] = [];
				for (const row of attachmentsRef.current) {
					if (
						row.state !== "committed" ||
						!["list", "task", "comment"].includes(row.parentKind)
					)
						continue;
					frozenSources.push(
						Object.freeze({
							id: row.id,
							workspaceId: row.workspaceId,
							parentId: row.parentId,
							parentKind: row.parentKind,
							keyVersion: row.keyVersion,
							filenameCiphertext: row.filenameCiphertext,
							contentTypeCiphertext: row.contentTypeCiphertext,
							dekWrapped: row.dekWrapped,
						}),
					);
				}
				const exactContentDocument = await (keyringRef.current.runtime
					.attachments?.archiveExport
					? keyringRef.current.runtime.attachments.archiveExport.readContent(
							abort.signal,
						)
					: boundedContent(abort.signal));
				abort.signal.throwIfAborted();
				const captured = createAttachmentExportController({
					exactContentDocument,
					ownerId,
					zero,
					keyring: () => keyringRef.current,
					signal: abort.signal,
					onProgress: (value) => {
						if (!abort.signal.aborted) setProgress(value.stage);
					},
				});
				controller.current = captured;
				const page = {
					sources: Object.freeze(frozenSources),
					offset: 0,
					running: false,
					controller: captured,
					signal: abort.signal,
				};
				pages.current = page;
				await loadPage(page);
				abort.signal.throwIfAborted();
				setStage("select");
			})().catch((error) => {
				if (!abort.signal.aborted) {
					setError(exportError(error));
					setStage("select");
				}
			});
		return () => {
			abort.abort();
			controller.current?.cancel();
			controller.current = null;
			pages.current = null;
		};
	}, [zero, boundary, supported, unlocked, loadPage]);

	useEffect(() => {
		if (pair && restorePreparedFocus.current) {
			restorePreparedFocus.current = false;
			if (document.activeElement === document.body)
				contentButton.current?.focus();
		}
	}, [pair]);

	function close() {
		active.current?.abort();
		controller.current?.cancel();
		setPassphrase("");
		setConfirmation("");
		setPair(null);
		onClose();
	}
	async function prepare() {
		const captured = controller.current;
		const signal = active.current?.signal;
		if (
			!captured ||
			!signal ||
			stage !== "select" ||
			pages.current?.running ||
			!withinBounds ||
			loadingMore ||
			!passphrase ||
			passphrase !== confirmation
		)
			return;
		restorePreparedFocus.current =
			document.activeElement === prepareButton.current;
		setStage("preparing");
		setError(null);
		setProgress("download");
		try {
			const result = await captured.exportSelected(sources, passphrase);
			signal.throwIfAborted();
			setPair(result);
			setStage("done");
		} catch (error) {
			if (!signal.aborted) {
				setError(exportError(error));
				setStage("select");
			}
		} finally {
			if (!signal.aborted) {
				setPassphrase("");
				setConfirmation("");
				setProgress(null);
			}
		}
	}
	async function download(kind: "content" | "files") {
		if (
			saving.current ||
			!unlocked ||
			!pair ||
			!isZeroClientOwnerActive(zero) ||
			active.current?.signal.aborted
		)
			return;
		const file = pair[kind];
		const runtime = keyring.runtime;
		if (runtime.attachments?.archiveExport) {
			const signal = active.current?.signal;
			if (!signal) return;
			saving.current = true;
			setSavingFile(true);
			setError(null);
			try {
				await saveNativeArchiveDocument(
					runtime.attachments,
					file,
					signal,
					() => {
						if (
							!isZeroClientOwnerActive(zero) ||
							keyringRef.current.runtime !== runtime ||
							!keyringRef.current.ready ||
							keyringRef.current.state !== "ready"
						)
							throw new Error("stale-export");
					},
				);
				setRequested((current) => ({ ...current, [kind]: true }));
			} catch (error) {
				if (!signal.aborted) setError(exportError(error));
			} finally {
				if (active.current?.signal === signal && !signal.aborted) {
					saving.current = false;
					setSavingFile(false);
				}
			}
			return;
		}
		const url = URL.createObjectURL(
			new Blob([file.json], { type: "application/json" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = file.filename;
		link.click();
		setRequested((current) => ({ ...current, [kind]: true }));
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

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
					data-testid="attachment-archive-export-dialog"
				>
					<DialogHeader>
						<DialogTitle>{m.archive_export_action()}</DialogTitle>
						<DialogDescription>
							{m.archive_export_description()}
						</DialogDescription>
					</DialogHeader>
					{!supported ? (
						<p role="status">{m.archive_export_browser_only()}</p>
					) : !unlocked ? (
						<div className="space-y-3">
							<p>{m.archive_export_locked()}</p>
							{keyring.state === "locked" && (
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
							{stage !== "done" && (
								<p
									id={`${id}-bounds`}
									className="text-sm text-muted-foreground"
								>
									{m.archive_export_bounds()}
								</p>
							)}
							{stage === "loading" ? (
								<p role="status">{m.archive_export_loading()}</p>
							) : (
								stage !== "done" &&
								!(error && entries.length === 0) && (
									<>
										{entries.length === 0 && !error && (
											<p>{m.archive_export_empty()}</p>
										)}
										<ul
											className="max-h-64 overflow-y-auto"
											aria-label={m.archive_export_selection()}
										>
											{entries.map((entry, index) => (
												<li
													key={entry.source.id}
													className="flex min-h-11 items-center gap-3 py-1"
												>
													<span className="flex shrink-0 items-center justify-center pointer-coarse:size-11">
														<Checkbox
															id={`${id}-file-${index}`}
															className="shrink-0 pointer-coarse:after:inset-auto pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2"
															checked={selected.includes(entry.source.id)}
															disabled={
																!entry.filename ||
																stage === "preparing" ||
																loadingMore ||
																(!selected.includes(entry.source.id) &&
																	selected.length >=
																		ATTACHMENT_ARCHIVE_LIMITS.entries)
															}
															onCheckedChange={(value) =>
																setSelected((current) =>
																	value === true
																		? current.includes(entry.source.id) ||
																			current.length >=
																				ATTACHMENT_ARCHIVE_LIMITS.entries
																			? current
																			: [...current, entry.source.id]
																		: current.filter(
																				(value) => value !== entry.source.id,
																			),
																)
															}
															aria-describedby={
																!entry.filename
																	? `${id}-reason-${index}`
																	: undefined
															}
														/>
													</span>
													<div className="min-w-0">
														<label
															className="block min-h-11 content-center break-words text-sm"
															htmlFor={`${id}-file-${index}`}
														>
															{entry.filename ??
																m.archive_export_unavailable_file()}
														</label>
														{!entry.filename && (
															<p
																id={`${id}-reason-${index}`}
																className="text-xs text-muted-foreground"
															>
																{m.archive_export_missing_key()}
															</p>
														)}
													</div>
												</li>
											))}
										</ul>
										{hasMore && (
											<Button
												className={controlClass}
												variant="outline"
												disabled={loadingMore || stage !== "select"}
												onClick={() => void loadMore()}
											>
												{m.archive_export_load_more()}
											</Button>
										)}
										{loadingMore && (
											<p role="status">{m.archive_export_loading()}</p>
										)}
										<div className="space-y-1.5">
											<label
												htmlFor={`${id}-passphrase`}
												className="text-sm font-medium"
											>
												{m.archive_export_passphrase()}
											</label>
											<Input
												id={`${id}-passphrase`}
												type="password"
												className="pointer-coarse:min-h-11"
												autoComplete="new-password"
												maxLength={1024}
												value={passphrase}
												disabled={stage === "preparing"}
												onChange={(event) => setPassphrase(event.target.value)}
												aria-describedby={`${id}-secret-note`}
											/>
										</div>
										<div className="space-y-1.5">
											<label
												htmlFor={`${id}-confirm`}
												className="text-sm font-medium"
											>
												{m.archive_export_confirm()}
											</label>
											<Input
												id={`${id}-confirm`}
												type="password"
												className="pointer-coarse:min-h-11"
												autoComplete="new-password"
												maxLength={1024}
												value={confirmation}
												disabled={stage === "preparing"}
												onChange={(event) =>
													setConfirmation(event.target.value)
												}
											/>
										</div>
										<p
											id={`${id}-secret-note`}
											className="text-sm text-muted-foreground"
										>
											{m.archive_export_secret_note()}
										</p>
										{confirmation && passphrase !== confirmation && (
											<p role="status">{m.archive_export_mismatch()}</p>
										)}
										{sources.length > 0 && !withinBounds && (
											<p
												id={`${id}-selection-limit`}
												role="status"
												className="text-sm text-warning"
											>
												{m.archive_export_selection_limit()}
											</p>
										)}
										<Button
											className={controlClass}
											disabled={
												stage !== "select" ||
												loadingMore ||
												!withinBounds ||
												!passphrase ||
												passphrase !== confirmation
											}
											aria-describedby={`${id}-bounds ${id}-secret-note${sources.length > 0 && !withinBounds ? ` ${id}-selection-limit` : ""}`}
											ref={prepareButton}
											onClick={() => void prepare()}
										>
											{m.archive_export_prepare()}
										</Button>
									</>
								)
							)}
							{pair && (
								<div className="space-y-3">
									<p>{m.archive_export_pair_note()}</p>
									<div className="flex flex-wrap gap-2">
										<Button
											className={controlClass}
											ref={contentButton}
											disabled={savingFile}
											onClick={() => void download("content")}
										>
											{m.archive_export_download_content()}
										</Button>
										<Button
											className={controlClass}
											disabled={savingFile}
											onClick={() => void download("files")}
										>
											{m.archive_export_download_files()}
										</Button>
									</div>
									<div className="space-y-2 break-words text-xs text-muted-foreground">
										<p role="status" aria-atomic="true">
											{filenameParts(pair.content.filename)}
											{requested.content && (
												<span className="block">
													{keyring.runtime.attachments?.archiveExport
														? m.archive_export_saved()
														: m.portability_download_requested()}
												</span>
											)}
										</p>
										<p role="status" aria-atomic="true">
											{filenameParts(pair.files.filename)}
											{requested.files && (
												<span className="block">
													{keyring.runtime.attachments?.archiveExport
														? m.archive_export_saved()
														: m.portability_download_requested()}
												</span>
											)}
										</p>
									</div>
								</div>
							)}
							<p role="status" aria-live="polite">
								{progress === "download"
									? m.archive_export_downloading()
									: progress === "authenticate-and-seal"
										? m.archive_export_sealing()
										: null}
							</p>
						</>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error === "pending"
								? m.archive_export_pending()
								: error === "limit"
									? m.portability_limit()
									: m.archive_export_failed()}
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
