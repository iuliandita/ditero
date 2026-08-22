import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RECOVERY_GROUP_SIZE } from "../../../domain/e2e/recovery-code.ts";
import { m } from "../../../paraglide/messages.js";

const DOWNLOAD_NAME = "ditero-recovery-code.txt";

export function RecoveryCodeCard({
	display,
	allowDownload,
}: {
	/** The hyphenated print form. Never the canonical derivation input. */
	display: string;
	allowDownload: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const codeRef = useRef<HTMLFieldSetElement>(null);
	const groups = display.split("-");

	// Focus lives here rather than in the caller: a wrapper element focused from
	// outside is only focusable if it carries its own tabIndex, and a caller that
	// forgets is a silent no-op -- the screen reader lands on Copy and the code
	// it is meant to read is never announced.
	useEffect(() => {
		codeRef.current?.focus();
	}, []);

	async function copy() {
		try {
			await navigator.clipboard.writeText(display);
			setCopied(true);
		} catch (error) {
			// A denied clipboard must not look like a copied code: leaving the
			// announcement unset is what keeps the user reading the block instead.
			console.error(error);
		}
	}

	function download() {
		const url = URL.createObjectURL(
			new Blob([display], { type: "text/plain" }),
		);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = DOWNLOAD_NAME;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="flex flex-col gap-3">
			{/*
			  dir="ltr" unconditionally: the code is Crockford base32 and its group
			  order is load-bearing, so under an RTL locale the groups would render
			  right-to-left and a user transcribing what they see would type a
			  reversed, permanently wrong code.
			*/}
			{/*
			  A fieldset, not a div with role="group": it carries the role
			  implicitly and needs no visible legend to be labelled. tabIndex -1
			  so the pane can focus it on entry and a screen reader reaches the
			  code before the Copy button.
			*/}
			<fieldset
				ref={codeRef}
				tabIndex={-1}
				aria-label={m.e2e_recovery_code_aria()}
				data-testid="e2e-recovery-code"
				dir="ltr"
				className="flex flex-wrap justify-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 p-3 text-center font-mono text-base tracking-widest select-all"
			>
				{groups.map((group) => (
					<span key={group} data-testid="e2e-recovery-group">
						{group}
					</span>
				))}
			</fieldset>

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					data-testid="e2e-recovery-copy"
					onClick={() => void copy()}
				>
					{m.e2e_recovery_copy()}
				</Button>
				{allowDownload && (
					<Button
						type="button"
						variant="outline"
						// Hidden below md by the caller: a bare .txt download on a
						// mobile browser lands somewhere most users cannot find.
						data-testid="e2e-recovery-download"
						onClick={download}
					>
						{m.e2e_recovery_download()}
					</Button>
				)}
			</div>

			<span role="status" className="sr-only">
				{copied && m.e2e_recovery_copied()}
			</span>
		</div>
	);
}

export { RECOVERY_GROUP_SIZE };
