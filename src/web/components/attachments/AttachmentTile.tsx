import {
	File,
	FileArchive,
	FileAudio,
	FileImage,
	FileText,
	FileVideo,
	X,
} from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { RowAction } from "../ui/row-action.ts";
import { RowActions } from "../ui/row-actions.tsx";

export type AttachmentDisplayState =
	| "ready"
	| "locked"
	| "unenrolled"
	| "pending"
	| "unrecoverable"
	| "integrity";

export type AttachmentProgress = {
	phase: "encrypting" | "uploading" | "transferring" | "decrypting";
	loaded: number;
	total: number;
};

function Filename({ value }: { value: string }) {
	const tailLength = Math.min(14, Math.max(5, Math.floor(value.length / 3)));
	const head = value.slice(0, Math.max(0, value.length - tailLength));
	const tail = value.slice(-tailLength);
	return (
		<span className="flex min-w-0" aria-hidden="true">
			<span className="truncate">{head}</span>
			<span className="shrink-0">{tail}</span>
		</span>
	);
}

function FileGlyph({ contentType }: { contentType?: string | null }) {
	if (contentType?.startsWith("image/")) return <FileImage />;
	if (contentType?.startsWith("audio/")) return <FileAudio />;
	if (contentType?.startsWith("video/")) return <FileVideo />;
	if (
		contentType?.startsWith("text/") ||
		contentType === "application/json" ||
		contentType === "application/pdf"
	)
		return <FileText />;
	if (
		contentType === "application/zip" ||
		contentType === "application/gzip" ||
		contentType === "application/x-7z-compressed" ||
		contentType === "application/x-rar-compressed"
	)
		return <FileArchive />;
	return <File />;
}

function Progress({
	progress,
	name,
}: {
	progress: AttachmentProgress;
	name: string;
}) {
	const maximum = Math.max(1, progress.total);
	const current = Math.min(maximum, Math.max(0, progress.loaded));
	const downloading =
		progress.phase === "transferring" || progress.phase === "decrypting";
	const label = downloading
		? m.attachment_download_progress_aria({ name })
		: m.attachment_upload_progress_aria({ name });
	const phase =
		progress.phase === "encrypting"
			? m.attachment_encrypting()
			: progress.phase === "uploading"
				? m.attachment_uploading()
				: progress.phase === "decrypting"
					? m.attachment_decrypting()
					: m.attachment_download();
	return (
		<div className="mt-1 flex w-full flex-col gap-1">
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={maximum}
				aria-valuenow={current}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className="h-full rounded-full bg-primary transition-[width]"
					style={{ width: `${(current / maximum) * 100}%` }}
				/>
			</div>
			<span className="text-xs text-muted-foreground">{phase}</span>
		</div>
	);
}

export function AttachmentTile({
	name,
	size,
	date,
	state,
	workspaceName,
	holderNames,
	thumbnailUrl,
	actions,
	onOpen,
	onSetup,
	progress,
	error,
	itemRef,
	contentType,
}: {
	name: string | null;
	size: string;
	date: string;
	state: AttachmentDisplayState;
	workspaceName: string;
	holderNames?: string;
	thumbnailUrl?: string | null;
	actions: RowAction[];
	onOpen?: () => void;
	onSetup?: () => void;
	progress?: AttachmentProgress;
	error?: string | null;
	itemRef?: Ref<HTMLLIElement>;
	contentType?: string | null;
}) {
	const displayName = name ?? m.attachment_locked_name();
	const meta = m.attachment_locked_meta({ size, date });
	const preview = state === "ready" && Boolean(thumbnailUrl);
	const statusLines =
		state === "pending"
			? [
					m.attachment_key_pending(),
					...(holderNames
						? [m.attachment_key_pending_who({ names: holderNames })]
						: []),
				]
			: state === "unrecoverable"
				? [
						m.attachment_unreadable(),
						m.attachment_unreadable_body({ workspace: workspaceName }),
					]
				: state === "unenrolled"
					? [m.attachment_key_pending_self()]
					: state === "locked"
						? [m.e2e_status_locked()]
						: state === "integrity"
							? [m.attachment_error_integrity()]
							: [];
	const accessibleLabel =
		state === "ready"
			? `${displayName}, ${size}`
			: `${displayName}. ${meta}. ${statusLines.join(" ")}`;

	return (
		<li
			ref={itemRef}
			tabIndex={-1}
			aria-label={accessibleLabel}
			className={cn(
				"group min-w-0 rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring",
				preview ? "overflow-hidden" : "flex items-start gap-2 p-2",
			)}
			{...(state !== "ready" ? { role: "group" } : {})}
		>
			{preview ? (
				<>
					<button
						type="button"
						onClick={onOpen}
						aria-label={m.attachment_open_named({ name: displayName })}
						className="block aspect-[4/3] w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					>
						<img
							src={thumbnailUrl ?? undefined}
							alt={m.attachment_thumbnail_alt({ name: displayName })}
							className="size-full object-cover"
						/>
					</button>
					<div className="flex min-w-0 items-start gap-2 p-2">
						<div className="min-w-0 flex-1">
							<span className="sr-only">{displayName}</span>
							<Filename value={displayName} />
							<span className="text-xs text-muted-foreground">{size}</span>
							{progress && <Progress progress={progress} name={displayName} />}
							{error && (
								<p role="alert" className="mt-1 text-xs text-destructive">
									{error}
								</p>
							)}
						</div>
						<RowActions
							actions={actions}
							label={m.row_actions_for({ name: displayName })}
						/>
					</div>
				</>
			) : (
				<>
					<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted md:size-9">
						{state === "ready" ? (
							<FileGlyph contentType={contentType} />
						) : (
							<File />
						)}
					</div>
					<div className="min-w-0 flex-1 py-0.5">
						{state === "ready" && onOpen ? (
							<button
								type="button"
								onClick={onOpen}
								aria-label={m.attachment_open_named({ name: displayName })}
								className="block w-full min-w-0 text-start font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="sr-only">{displayName}</span>
								<Filename value={displayName} />
							</button>
						) : (
							<p className="font-medium">{displayName}</p>
						)}
						<p className="text-xs text-muted-foreground">{meta}</p>
						{state !== "ready" && statusLines.length > 0 && (
							<div className="mt-1 text-xs text-muted-foreground">
								{statusLines.map((line) => (
									<p key={line}>{line}</p>
								))}
							</div>
						)}
						{state === "unenrolled" && onSetup && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-2 min-h-11 md:min-h-0"
								onClick={onSetup}
							>
								{m.e2e_setup_action()}
							</Button>
						)}
						{state === "locked" && onOpen && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-2 min-h-11 md:min-h-0"
								onClick={onOpen}
							>
								{m.e2e_unlock_submit()}
							</Button>
						)}
						{progress && <Progress progress={progress} name={displayName} />}
						{error && (
							<p role="alert" className="mt-1 text-xs text-destructive">
								{error}
							</p>
						)}
					</div>
					<RowActions
						actions={actions}
						label={m.row_actions_for({ name: displayName })}
					/>
				</>
			)}
		</li>
	);
}

export function PendingAttachmentTile({
	name,
	size,
	progress,
	onCancel,
	ready,
	error,
	status,
}: {
	name: string;
	size: string;
	progress?: AttachmentProgress;
	onCancel?: () => void;
	ready?: boolean;
	error?: string;
	status?: string;
}) {
	return (
		<li className="flex min-w-0 items-start gap-2 rounded-xl border bg-card p-2">
			<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted md:size-9">
				<File />
			</div>
			<div className="min-w-0 flex-1 py-0.5">
				<span className="sr-only">{name}</span>
				<Filename value={name} />
				<p className="text-xs text-muted-foreground">{size}</p>
				{ready && (
					<p className="text-xs text-muted-foreground">
						{m.attachment_ready_to_upload()}
					</p>
				)}
				{status && <p className="text-xs text-muted-foreground">{status}</p>}
				{progress && <Progress progress={progress} name={name} />}
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</div>
			{onCancel && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-11 md:size-7"
					aria-label={m.attachment_cancel_upload()}
					onClick={onCancel}
				>
					<X />
				</Button>
			)}
		</li>
	);
}
