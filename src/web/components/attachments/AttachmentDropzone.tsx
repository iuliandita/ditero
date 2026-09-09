import { Paperclip, Plus } from "lucide-react";
import {
	type ClipboardEvent,
	forwardRef,
	type ReactNode,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { WorkspaceKeyMaterial } from "../../lib/e2e/KeyringProvider.tsx";
import {
	AttachmentGateChrome,
	type AttachmentGateController,
} from "./states.tsx";

export type AttachmentDropzoneHandle = {
	openPicker: () => void;
	focusButton: () => boolean;
};

export type AttachmentDropzoneProps = {
	gate: AttachmentGateController;
	workspaceName: string;
	onFilesReady: (
		files: File[],
		key: WorkspaceKeyMaterial,
	) => void | Promise<void>;
	children?: ReactNode;
	showButton?: boolean;
	enabled?: boolean;
	buttonLabel?: string;
	compact?: boolean;
	className?: string;
};

function clipboardFiles(event: ClipboardEvent): File[] {
	const files: File[] = [];
	for (const item of event.clipboardData.items) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (!file) continue;
		if (file.type.startsWith("image/")) {
			files.push(
				new File([file], `pasted-image-${Date.now()}.png`, {
					type: file.type || "image/png",
				}),
			);
		} else {
			files.push(file);
		}
	}
	return files;
}

export const AttachmentDropzone = forwardRef<
	AttachmentDropzoneHandle,
	AttachmentDropzoneProps
>(function AttachmentDropzone(
	{
		gate,
		workspaceName,
		onFilesReady,
		children,
		showButton = true,
		enabled = true,
		buttonLabel = m.attachment_add(),
		compact = false,
		className,
	},
	ref,
) {
	const input = useRef<HTMLInputElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const [dragging, setDragging] = useState(false);

	function openPicker() {
		gate.clearError();
		if (!enabled) return;
		if (gate.blocked) {
			gate.focusBlockedSurface();
			return;
		}
		input.current?.click();
	}

	useImperativeHandle(ref, () => ({
		openPicker,
		focusButton: () => {
			if (button.current) {
				button.current.focus();
				return true;
			}
			if (gate.blocked) {
				gate.focusBlockedSurface();
				return true;
			}
			return false;
		},
	}));

	async function accept(files: File[]) {
		setDragging(false);
		if (!enabled) return;
		await gate.runWithFiles(files, async (key, ready) => {
			await onFilesReady(ready, key);
		});
	}

	return (
		<fieldset
			aria-label={m.attachment_dropzone_aria()}
			className={cn(
				"relative m-0 flex min-w-0 flex-col gap-2 border-0 p-0",
				className,
			)}
			onDragEnter={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				if (!enabled || gate.blocked) return;
				setDragging(true);
			}}
			onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect =
					!enabled || gate.blocked ? "none" : "copy";
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					setDragging(false);
				}
			}}
			onDrop={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				if (!enabled) return;
				if (gate.blocked) {
					gate.focusBlockedSurface();
					return;
				}
				void accept(Array.from(event.dataTransfer.files));
			}}
			onPaste={(event) => {
				if (!enabled) return;
				const files = clipboardFiles(event);
				if (files.length === 0) return;
				event.preventDefault();
				void accept(files);
			}}
		>
			<input
				ref={input}
				data-testid="attachment-input"
				type="file"
				multiple
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? []);
					event.currentTarget.value = "";
					void accept(files);
				}}
			/>

			{children}

			{enabled && !gate.blocked && showButton && (
				<div className={cn("flex items-center gap-2", !compact && "flex-wrap")}>
					<Button
						ref={button}
						type="button"
						variant="outline"
						size="sm"
						className="min-h-11 md:min-h-0"
						onClick={openPicker}
					>
						{compact ? <Paperclip /> : <Plus />}
						{buttonLabel}
					</Button>
					{!compact && (
						<span className="hidden text-xs text-muted-foreground md:inline">
							{dragging
								? m.attachment_dropzone_active()
								: m.attachment_dropzone_hint()}
						</span>
					)}
				</div>
			)}

			{dragging && enabled && !gate.blocked && (
				<div className="pointer-events-none absolute inset-0 z-10 hidden items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 text-sm font-medium md:flex">
					{m.attachment_dropzone_active()}
				</div>
			)}

			<AttachmentGateChrome gate={gate} workspaceName={workspaceName} />
		</fieldset>
	);
});
