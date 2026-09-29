import { FileUp } from "lucide-react";
import { type DragEvent, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { buttonVariants } from "./button.tsx";

/**
 * A file input that looks like the rest of the app. The real input stays in
 * the tab order (visually hidden) and owns the label, so keyboard and screen
 * reader users get the native control; the visible button is a pointer
 * shortcut to it, and the zone also accepts a dropped file.
 */
export function FilePicker({
	label,
	accept,
	fileName,
	disabled = false,
	describedBy,
	onFile,
	"data-testid": testId,
}: {
	label: string;
	accept?: string;
	fileName: string | null;
	disabled?: boolean;
	describedBy?: string;
	onFile: (file: File | undefined) => void;
	"data-testid"?: string;
}) {
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);

	function drop(event: DragEvent<HTMLDivElement>) {
		event.preventDefault();
		setOver(false);
		if (disabled) return;
		const file = event.dataTransfer.files[0];
		if (file) onFile(file);
	}

	return (
		<div className="flex flex-col gap-1 text-sm">
			<label htmlFor={id} className="text-muted-foreground">
				{label}
			</label>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only drop target; the input inside is the accessible control. */}
			<div
				data-testid={testId}
				data-over={over || undefined}
				className={cn(
					"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-input px-3 py-3 transition-colors duration-(--motion-fast) ease-(--motion-ease) has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring motion-reduce:transition-none data-over:border-ring data-over:bg-muted",
					disabled && "opacity-50",
				)}
				onDragOver={(event) => {
					if (disabled) return;
					event.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={drop}
			>
				<input
					ref={input}
					id={id}
					type="file"
					accept={accept}
					disabled={disabled}
					aria-describedby={describedBy}
					className="sr-only"
					onChange={(event) => {
						onFile(event.target.files?.[0]);
						// Lets the same file be chosen again after an error.
						event.target.value = "";
					}}
				/>
				<button
					type="button"
					tabIndex={-1}
					aria-hidden="true"
					disabled={disabled}
					className={cn(
						buttonVariants({ variant: "outline" }),
						"pointer-coarse:h-11",
					)}
					onClick={() => input.current?.click()}
				>
					<FileUp />
					{m.file_picker_choose()}
				</button>
				<span
					className={cn(
						"min-w-0 truncate",
						fileName ? "text-foreground" : "text-muted-foreground",
					)}
					data-testid={testId ? `${testId}-name` : undefined}
					aria-live="polite"
				>
					{fileName ?? m.file_picker_none()}
				</span>
				<span className="text-xs text-muted-foreground pointer-coarse:hidden">
					{m.file_picker_drop()}
				</span>
			</div>
		</div>
	);
}
