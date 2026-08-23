import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { m } from "../../../paraglide/messages.js";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { KeyringError } from "../../lib/e2e/keyring.ts";
import { RecoverDialog } from "./RecoverDialog.tsx";

// Shell flow 2. Demand-driven: nothing prompts for a passphrase at app start,
// because a prompt with no file in front of it trains people to type it
// reflexively.
export function UnlockDialog({
	open,
	onOpenChange,
	userId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	userId: string;
}) {
	const { unlock, lockedByTimeout } = useKeyring();
	const [passphrase, setPassphrase] = useState("");
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Shell flow 3 puts recovery in THIS dialog rather than a route of its own:
	// a user who has just failed a passphrase must not lose the surface they
	// were on to get to their recovery code.
	const [recovering, setRecovering] = useState(false);
	const [dismissable, setDismissable] = useState(true);
	const passphraseId = useId();
	const hintId = useId();

	useEffect(() => {
		if (!open) {
			setPassphrase("");
			setError(null);
			setBusy(false);
			setRecovering(false);
			setDismissable(true);
		}
	}, [open]);

	// Stable, because RecoverDialog reports through it from an effect.
	const reportDismissable = useCallback((value: boolean) => {
		setDismissable(value);
	}, []);

	async function submit(): Promise<void> {
		if (busy || !passphrase) return;
		setBusy(true);
		setError(null);
		try {
			await unlock(passphrase, remember);
			onOpenChange(false);
		} catch (caught) {
			// "stale" and "wrong-secret" are not the same message: no passphrase
			// fixes a record this build cannot read, and telling the user to try
			// again would send them looking for a mistake they did not make.
			setError(
				caught instanceof KeyringError && caught.reason === "stale"
					? m.e2e_unlock_stale()
					: m.e2e_unlock_wrong_passphrase(),
			);
			// The field keeps its value on purpose. There is no attempt counter
			// and no lockout: the check is local, so a counter would be both
			// unenforceable and a lie.
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value && !dismissable) return;
				onOpenChange(value);
			}}
		>
			<DialogContent
				data-testid="e2e-unlock-dialog"
				{...(dismissable ? {} : { onEscapeKeyDown: preventDefault })}
			>
				{recovering ? (
					<RecoverDialog
						userId={userId}
						onDismissable={reportDismissable}
						onDone={() => onOpenChange(false)}
					/>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>{m.e2e_unlock_title()}</DialogTitle>
							<DialogDescription data-testid="e2e-unlock-description">
								{lockedByTimeout
									? m.e2e_unlock_description_timeout()
									: m.e2e_unlock_description()}
							</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5">
								<label htmlFor={passphraseId} className="text-sm font-medium">
									{m.e2e_field_passphrase()}
								</label>
								<Input
									id={passphraseId}
									data-testid="e2e-unlock-passphrase"
									type="password"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									value={passphrase}
									onChange={(event) => setPassphrase(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void submit();
									}}
								/>
							</div>

							<div className="flex items-start gap-2">
								<Checkbox
									id={`${passphraseId}-remember`}
									data-testid="e2e-unlock-remember"
									checked={remember}
									onCheckedChange={(next) => setRemember(next === true)}
									aria-describedby={hintId}
								/>
								<div className="flex flex-col gap-1">
									<label
										htmlFor={`${passphraseId}-remember`}
										className="text-sm font-medium"
									>
										{m.e2e_unlock_remember_label()}
									</label>
									{/*
							  A described-by line, not a tooltip: it states what the
							  control does and when not to use it, and touch cannot
							  trigger a tooltip.
							*/}
									<span id={hintId} className="text-sm text-muted-foreground">
										{m.e2e_unlock_remember_hint()}
									</span>
								</div>
							</div>

							{error && (
								<p
									role="alert"
									data-testid="e2e-unlock-error"
									className="text-sm text-destructive"
								>
									{error}
								</p>
							)}

							<Button
								type="button"
								className="self-end"
								data-testid="e2e-unlock-submit"
								disabled={busy || !passphrase}
								onClick={() => void submit()}
							>
								{busy ? m.e2e_unlock_working() : m.e2e_unlock_submit()}
							</Button>

							{/*
					  Below the submit button, so the primary action stays in the
					  thumb zone on mobile. A link, not a second button: it is a
					  way out, not an alternative of equal standing.
					*/}
							<button
								type="button"
								data-testid="e2e-use-recovery"
								className="self-start text-sm underline underline-offset-4"
								onClick={() => setRecovering(true)}
							>
								{m.e2e_unlock_use_recovery()}
							</button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function preventDefault(event: Event) {
	event.preventDefault();
}
