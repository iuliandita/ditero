import { useQuery, useZero } from "@rocicorp/zero/react";
import { Download, ExternalLink, Trash2 } from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { isPreviewable } from "../../../domain/attachment.ts";
import { StreamError } from "../../../domain/e2e/stream.ts";
import { randomId } from "../../../domain/random-id.ts";
import { ADMIN_ROLES, type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { Attachment, schema } from "../../../zero/schema.gen.ts";
import {
	deleteAttachment,
	fetchMyGrants,
	type MyAttachmentGrant,
} from "../../lib/e2e/attachment-api.ts";
import {
	type DecryptedAttachmentMetadata,
	decryptAttachmentMetadata,
	downloadAttachment,
	downloadAttachmentThumbnail,
} from "../../lib/e2e/download.ts";
import {
	useKeyring,
	type WorkspaceKeyMaterial,
} from "../../lib/e2e/KeyringProvider.tsx";
import { uploadAttachment } from "../../lib/e2e/upload.ts";
import { formatBytes } from "../../lib/intl-format.ts";
import { useConfirm } from "../ui/confirm.tsx";
import type { RowAction } from "../ui/row-action.ts";
import {
	AttachmentDropzone,
	type AttachmentDropzoneHandle,
} from "./AttachmentDropzone.tsx";
import {
	type AttachmentDisplayState,
	type AttachmentProgress,
	AttachmentTile,
	PendingAttachmentTile,
} from "./AttachmentTile.tsx";
import {
	grantForAttachment,
	grantHolderNames,
	useAttachmentGate,
} from "./states.tsx";

type ParentKind = "task" | "comment" | "list";
type Variant = ParentKind;

type PendingUpload = {
	id: string;
	file: File;
	controller: AbortController;
	progress?: AttachmentProgress;
	error?: string;
	done: boolean;
};

type ResolvedRow = {
	metadata?: DecryptedAttachmentMetadata;
	integrityFailure?: boolean;
};

type Thumbnail = { url: string; revoke: () => void };

export type AttachmentListHandle = {
	openPicker: () => void;
	focusAdd: () => void;
};

export type AttachmentListProps = {
	workspaceId: string;
	parentKind: ParentKind;
	parentId: string;
	variant?: Variant;
	showAdd?: boolean;
	className?: string;
	onEmptyFocus?: () => void;
};

const ACCESS_POLL_MS = 15_000;

function formatCreatedAt(value: number | null | undefined): string {
	if (value == null) return m.attachment_date_unknown();
	return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(
		value,
	);
}

function triggerBlob(
	result: { url: string; filename: string; revoke: () => void },
	download: boolean,
) {
	const anchor = document.createElement("a");
	anchor.href = result.url;
	if (download) anchor.download = result.filename;
	else {
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(result.revoke, 1_000);
}

function rowState(
	keyringState: "unenrolled" | "locked" | "ready",
	resolved: ResolvedRow | undefined,
	grant: MyAttachmentGrant | null,
): AttachmentDisplayState {
	if (keyringState === "unenrolled") return "unenrolled";
	if (keyringState === "locked") return "locked";
	if (resolved?.integrityFailure) return "integrity";
	if (resolved?.metadata) return "ready";
	return grant?.state === "unrecoverable" ? "unrecoverable" : "pending";
}

export const AttachmentList = forwardRef<
	AttachmentListHandle,
	AttachmentListProps
>(function AttachmentList(
	{
		workspaceId,
		parentKind,
		parentId,
		variant = parentKind,
		showAdd = variant !== "comment",
		className,
		onEmptyFocus,
	},
	ref,
) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
	const keyring = useKeyring();
	const [allAttachments] = useQuery(queries.attachments.mine());
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const workspace = workspaces.find((row) => row.id === workspaceId);
	const workspaceName = workspace?.name ?? m.field_workspace();
	const gate = useAttachmentGate(workspaceId);
	const dropzone = useRef<AttachmentDropzoneHandle>(null);
	const itemRefs = useRef(new Map<string, HTMLLIElement>());
	const thumbnailLoads = useRef(new Set<string>());
	const thumbnailRef = useRef(new Map<string, Thumbnail>());
	const [resolved, setResolved] = useState(new Map<string, ResolvedRow>());
	const [thumbnails, setThumbnails] = useState(new Map<string, Thumbnail>());
	const [grants, setGrants] = useState<MyAttachmentGrant[]>([]);
	const [accessRevision, setAccessRevision] = useState(0);
	const [pending, setPending] = useState<PendingUpload[]>([]);
	const pendingRef = useRef<PendingUpload[]>([]);
	const [rowErrors, setRowErrors] = useState(new Map<string, string>());
	const [rowProgress, setRowProgress] = useState(
		new Map<string, AttachmentProgress>(),
	);
	const [announcement, setAnnouncement] = useState("");

	const attachments = useMemo(
		() =>
			allAttachments
				.filter(
					(row) => row.parentKind === parentKind && row.parentId === parentId,
				)
				.slice()
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
		[allAttachments, parentId, parentKind],
	);
	const attachmentIds = useMemo(
		() => new Set(attachments.map((row) => row.id)),
		[attachments],
	);
	const role =
		(memberships.find(
			(row) => row.workspaceId === workspaceId && row.userId === zero.userID,
		)?.role as Role | undefined) ?? null;
	const canWrite = role !== null && WRITE_ROLES.has(role);

	useImperativeHandle(ref, () => ({
		openPicker: () => dropzone.current?.openPicker(),
		focusAdd: () => dropzone.current?.focusButton(),
	}));

	useEffect(() => {
		setPending((rows) => rows.filter((row) => !attachmentIds.has(row.id)));
	}, [attachmentIds]);

	useEffect(() => {
		if (keyring.state === "ready") return;
		for (const thumbnail of thumbnailRef.current.values()) thumbnail.revoke();
		thumbnailRef.current.clear();
		thumbnailLoads.current.clear();
		setThumbnails(new Map());
		setResolved(new Map());
	}, [keyring.state]);

	useEffect(() => {
		pendingRef.current = pending;
	}, [pending]);

	useEffect(
		() => () => {
			for (const thumbnail of thumbnailRef.current.values()) thumbnail.revoke();
			for (const upload of pendingRef.current) upload.controller.abort();
		},
		[],
	);

	useEffect(() => {
		const liveIds = new Set(attachments.map((row) => row.id));
		for (const [id, thumbnail] of thumbnailRef.current) {
			if (liveIds.has(id)) continue;
			thumbnail.revoke();
			thumbnailRef.current.delete(id);
		}
		setThumbnails(new Map(thumbnailRef.current));
		setResolved(
			(current) => new Map([...current].filter(([id]) => liveIds.has(id))),
		);
	}, [attachments]);

	const refreshAccess = useCallback(async () => {
		await keyring.refreshWorkspaceKeys();
		try {
			setGrants(await fetchMyGrants());
		} catch (caught) {
			console.error("attachments: grant state failed", caught);
		}
		setAccessRevision((value) => value + 1);
	}, [keyring]);

	useEffect(() => {
		if (keyring.state !== "ready" || attachments.length === 0) return;
		// The poll increments this after refreshing memory-only workspace keys.
		// Reading it here makes that refresh a deliberate resolve trigger.
		void accessRevision;
		let active = true;
		void (async () => {
			let missing = false;
			const next = new Map<string, ResolvedRow>();
			await Promise.all(
				attachments.map(async (row) => {
					const key = await keyring.workspaceKey(workspaceId, row.keyVersion);
					if (!active) return;
					if (!key) {
						missing = true;
						return;
					}
					try {
						next.set(row.id, {
							metadata: await decryptAttachmentMetadata(row, key.wdk),
						});
					} catch (caught) {
						console.error(
							"attachments: metadata integrity check failed",
							caught,
						);
						next.set(row.id, { integrityFailure: true });
					}
				}),
			);
			if (!active) return;
			setResolved(next);
			if (missing) {
				try {
					setGrants(await fetchMyGrants());
				} catch (caught) {
					console.error("attachments: grant state failed", caught);
				}
			}
		})();
		return () => {
			active = false;
		};
	}, [accessRevision, attachments, keyring, workspaceId]);

	const unresolved =
		keyring.state === "ready" &&
		attachments.some((row) => !resolved.has(row.id));
	useEffect(() => {
		if (!unresolved) return;
		const timer = window.setInterval(
			() => void refreshAccess(),
			ACCESS_POLL_MS,
		);
		return () => window.clearInterval(timer);
	}, [refreshAccess, unresolved]);

	useEffect(() => {
		if (keyring.state !== "ready") return;
		let active = true;
		for (const row of attachments) {
			const metadata = resolved.get(row.id)?.metadata;
			if (
				!metadata ||
				!isPreviewable(metadata.contentType) ||
				!row.thumbnailStorageKey ||
				thumbnailRef.current.has(row.id) ||
				thumbnailLoads.current.has(row.id)
			)
				continue;
			thumbnailLoads.current.add(row.id);
			void keyring
				.workspaceKey(workspaceId, row.keyVersion)
				.then(async (key) => {
					if (!key) return null;
					return await downloadAttachmentThumbnail(row, key.wdk);
				})
				.then((thumbnail) => {
					if (!thumbnail) return;
					if (!active) {
						thumbnail.revoke();
						return;
					}
					const value = { url: thumbnail.url, revoke: thumbnail.revoke };
					thumbnailRef.current.set(row.id, value);
					setThumbnails(new Map(thumbnailRef.current));
				})
				.catch((caught: unknown) => {
					console.error("attachments: thumbnail failed", caught);
				})
				.finally(() => thumbnailLoads.current.delete(row.id));
		}
		return () => {
			active = false;
		};
	}, [attachments, keyring, resolved, workspaceId]);

	function updatePending(id: string, patch: Partial<PendingUpload>) {
		setPending((rows) =>
			rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
		);
	}

	async function startUploads(files: File[], key: WorkspaceKeyMaterial) {
		const uploads = files.map((file) => ({
			id: randomId(),
			file,
			controller: new AbortController(),
			done: false,
		}));
		setPending((current) => [...current, ...uploads]);
		for (const upload of uploads) {
			if (upload.controller.signal.aborted) continue;
			try {
				await uploadAttachment(
					{
						file: upload.file,
						workspaceId,
						parentKind,
						parentId,
						keyVersion: key.keyVersion,
						wdk: key.wdk,
					},
					{
						id: upload.id,
						signal: upload.controller.signal,
						onProgress: (progress) =>
							updatePending(upload.id, {
								progress: {
									phase:
										progress.phase === "encrypting"
											? "encrypting"
											: "uploading",
									loaded: progress.loaded,
									total: progress.total,
								},
							}),
					},
				);
				updatePending(upload.id, { done: true });
				setAnnouncement(
					m.attachment_added({ date: formatCreatedAt(Date.now()) }),
				);
			} catch (caught) {
				if (upload.controller.signal.aborted) continue;
				console.error("attachments: upload failed", caught);
				gate.reportUploadFailure(caught);
				updatePending(upload.id, {
					error: m.attachment_error_upload_failed(),
					progress: undefined,
				});
			}
		}
	}

	function cancelUpload(upload: PendingUpload) {
		upload.controller.abort();
		setPending((rows) => rows.filter((row) => row.id !== upload.id));
		setAnnouncement(m.attachment_upload_cancelled());
	}

	function setRowError(id: string, message: string | null) {
		setRowErrors((current) => {
			const next = new Map(current);
			if (message === null) next.delete(id);
			else next.set(id, message);
			return next;
		});
	}

	async function withDownload(
		row: Attachment,
		mode: "open" | "download",
		key: WorkspaceKeyMaterial,
	) {
		setRowError(row.id, null);
		try {
			if (mode === "open") {
				const metadata = await decryptAttachmentMetadata(row, key.wdk);
				if (!isPreviewable(metadata.contentType)) {
					setRowError(row.id, m.attachment_preview_unavailable());
					return;
				}
			}
			const result = await downloadAttachment(row, key.wdk, {
				onProgress: (progress) =>
					setRowProgress((current) => {
						const next = new Map(current);
						next.set(row.id, progress);
						return next;
					}),
			});
			triggerBlob(result, mode === "download");
		} catch (caught) {
			console.error("attachments: download failed", caught);
			setRowError(
				row.id,
				caught instanceof StreamError
					? m.attachment_error_integrity()
					: m.attachment_error_download_failed(),
			);
		} finally {
			setRowProgress((current) => {
				const next = new Map(current);
				next.delete(row.id);
				return next;
			});
		}
	}

	async function openRow(row: Attachment, mode: "open" | "download") {
		await gate.runWithKey(row.keyVersion, (key) =>
			withDownload(row, mode, key),
		);
	}

	async function removeRow(row: Attachment, index: number, name: string) {
		const ok = await confirm({
			title: m.attachment_delete_title(),
			body:
				resolved.get(row.id)?.metadata === undefined &&
				grantForAttachment(grants, workspaceId, row.keyVersion)?.state ===
					"unrecoverable"
					? m.attachment_unreadable_delete_confirm({ name })
					: m.attachment_delete_confirm({ name, workspace: workspaceName }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		try {
			await deleteAttachment(row.id);
			const next = attachments[index + 1] ?? attachments[index - 1];
			requestAnimationFrame(() => {
				if (next) itemRefs.current.get(next.id)?.focus();
				else if (!dropzone.current?.focusButton()) onEmptyFocus?.();
			});
		} catch (caught) {
			console.error("attachments: delete failed", caught);
			setRowError(row.id, m.attachment_error_delete_failed());
		}
	}

	function actionsFor(
		row: Attachment,
		state: AttachmentDisplayState,
		name: string,
		index: number,
	): RowAction[] {
		const readable = state === "ready" || state === "locked";
		const mayDelete =
			state === "unrecoverable"
				? role !== null && ADMIN_ROLES.has(role)
				: canWrite;
		return [
			{
				id: "open",
				label: m.attachment_open(),
				icon: ExternalLink,
				hidden: !readable,
				onSelect: () => void openRow(row, "open"),
			},
			{
				id: "download",
				label: m.attachment_download(),
				icon: Download,
				hidden: !readable,
				onSelect: () => void openRow(row, "download"),
			},
			{
				id: "delete",
				label: m.attachment_delete(),
				icon: Trash2,
				destructive: true,
				hidden: !mayDelete,
				onSelect: () => void removeRow(row, index, name),
			},
		];
	}

	const tiles = attachments.map((row, index) => {
		const value = resolved.get(row.id);
		const grant = grantForAttachment(grants, workspaceId, row.keyVersion);
		const state = rowState(keyring.state, value, grant);
		const name = value?.metadata?.filename ?? null;
		const displayName = name ?? m.attachment_locked_name();
		return {
			row,
			index,
			state,
			name,
			contentType: value?.metadata?.contentType,
			preview: thumbnails.get(row.id)?.url ?? null,
			actions: actionsFor(row, state, displayName, index),
			holders: grantHolderNames(grant),
		};
	});
	const previews = tiles.filter((tile) => tile.preview !== null);
	const chips = tiles.filter((tile) => tile.preview === null);
	const count = attachments.length + pending.length;

	const content = (
		<>
			{previews.length > 0 && (
				<ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{previews.map((tile) => (
						<AttachmentTile
							key={tile.row.id}
							name={tile.name}
							contentType={tile.contentType}
							size={formatBytes(tile.row.declaredBytes)}
							date={formatCreatedAt(tile.row.createdAt)}
							state={tile.state}
							workspaceName={workspaceName}
							holderNames={tile.holders}
							thumbnailUrl={tile.preview}
							actions={tile.actions}
							onOpen={() => void openRow(tile.row, "open")}
							error={rowErrors.get(tile.row.id)}
							progress={rowProgress.get(tile.row.id)}
							itemRef={(node) => {
								if (node) itemRefs.current.set(tile.row.id, node);
								else itemRefs.current.delete(tile.row.id);
							}}
						/>
					))}
				</ul>
			)}
			{(chips.length > 0 || pending.length > 0) && (
				<ul className="flex flex-col gap-2">
					{chips.map((tile) => (
						<AttachmentTile
							key={tile.row.id}
							name={tile.name}
							contentType={tile.contentType}
							size={formatBytes(tile.row.declaredBytes)}
							date={formatCreatedAt(tile.row.createdAt)}
							state={tile.state}
							workspaceName={workspaceName}
							holderNames={tile.holders}
							actions={tile.actions}
							onOpen={
								tile.state === "ready" || tile.state === "locked"
									? () => void openRow(tile.row, "open")
									: undefined
							}
							onSetup={
								tile.state === "unenrolled"
									? () =>
											void gate.runWithKey(tile.row.keyVersion, async () =>
												refreshAccess(),
											)
									: undefined
							}
							error={rowErrors.get(tile.row.id)}
							progress={rowProgress.get(tile.row.id)}
							itemRef={(node) => {
								if (node) itemRefs.current.set(tile.row.id, node);
								else itemRefs.current.delete(tile.row.id);
							}}
						/>
					))}
					{pending.map((upload) => (
						<PendingAttachmentTile
							key={upload.id}
							name={upload.file.name}
							size={formatBytes(upload.file.size)}
							progress={upload.progress}
							error={upload.error}
							status={
								upload.done
									? m.attachment_added({
											date: formatCreatedAt(Date.now()),
										})
									: undefined
							}
							onCancel={upload.done ? undefined : () => cancelUpload(upload)}
						/>
					))}
				</ul>
			)}
		</>
	);

	return (
		<AttachmentDropzone
			ref={dropzone}
			gate={gate}
			enabled={canWrite}
			workspaceName={workspaceName}
			onFilesReady={startUploads}
			showButton={showAdd && canWrite && variant === "task"}
			buttonLabel={m.attachment_add()}
			className={className}
		>
			{variant === "task" ? (
				<section className="flex flex-col gap-2" data-testid="task-attachments">
					<h3 className="text-sm text-muted-foreground">
						{m.attachment_section_heading()}
					</h3>
					{content}
					{count === 0 && (
						<p className="text-xs text-muted-foreground">
							{m.attachment_empty()}
						</p>
					)}
				</section>
			) : variant === "list" && count > 0 ? (
				<details
					className="mb-3 rounded-xl border px-3 py-2"
					data-testid="list-attachments"
				>
					<summary className="cursor-pointer text-sm font-medium">
						{m.attachment_count_label({ count })}
					</summary>
					<div className="mt-2 flex flex-col gap-2">{content}</div>
				</details>
			) : variant === "comment" ? (
				<div
					className="mt-1 flex flex-col gap-2"
					data-testid="comment-attachments"
				>
					{content}
				</div>
			) : null}
			<span role="status" className="sr-only">
				{announcement}
			</span>
		</AttachmentDropzone>
	);
});
