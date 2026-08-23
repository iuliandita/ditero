import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CURRENT_KDF_VERSION } from "../../../domain/e2e/kdf.ts";
import {
	generateRecoveryCode,
	normaliseRecoveryCode,
	RecoveryCodeError,
} from "../../../domain/e2e/recovery-code.ts";
import { m } from "../../../paraglide/messages.js";
import { createDeriver } from "../../lib/e2e/derive.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { KeyringError } from "../../lib/e2e/keyring.ts";
import {
	buildReplacement,
	fetchRecoveryIdentity,
	openPassphraseWrap,
	postRewrap,
	RewrapError,
} from "../../lib/e2e/rewrap.ts";
import { MIN_PASSPHRASE_LENGTH } from "./EnrollmentWizard.tsx";
import { RecoveryCodeCard } from "./RecoveryCodeCard.tsx";

export type PassphraseDialogMode = "change" | "regenerate";

type Pane = "verify" | "display" | "done";

/**
 * Shell section 4.2. Both flows open with the CURRENT passphrase, which is why
 * they share a component: "unlocked" can mean this browser held a stored key,
 * so an unlocked keyring is not evidence that the person at the keyboard knows
 * the secret. They diverge only in what the verified key is then used for.
 */
export function PassphraseDialog({
	mode,
	open,
	onOpenChange,
	userId,
}: {
	mode: PassphraseDialogMode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	userId: string;
}) {
	const { identity, refresh } = useKeyring();
	const [pane, setPane] = useState<Pane>("verify");
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirmNext, setConfirmNext] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [typed, setTyped] = useState("");
	const [confirmError, setConfirmError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [issued, setIssued] = useState<{
		display: string;
		canonical: string;
	} | null>(null);

	const currentId = useId();
	const nextId = useId();
	const confirmId = useId();
	const typedId = useId();

	const deriver = useMemo(() => createDeriver(), []);
	useEffect(() => () => deriver.dispose(), [deriver]);

	useEffect(() => {
		if (open) return;
		setPane("verify");
		setCurrent("");
		setNext("");
		setConfirmNext("");
		setError(null);
		setTyped("");
		setConfirmError(null);
		setBusy(false);
		setIssued(null);
	}, [open]);

	async function submitVerify(): Promise<void> {
		if (busy || !current) return;
		if (mode === "change") {
			if (next.length < MIN_PASSPHRASE_LENGTH) {
				setError(m.e2e_passphrase_too_short());
				return;
			}
			if (next !== confirmNext) {
				setError(m.e2e_passphrase_mismatch());
				return;
			}
		}
		setBusy(true);
		setError(null);
		try {
			if (!identity?.passphraseWrapped || !identity.passphraseSalt) {
				throw new RewrapError("failed", "passphrase: identity is incomplete");
			}
			const version = identity.formatVersion ?? CURRENT_KDF_VERSION;
			const privateKey = await openPassphraseWrap({
				userId,
				wrapped: identity.passphraseWrapped,
				salt: identity.passphraseSalt,
				version,
				secret: current,
				derive: deriver.derive,
			});

			if (mode === "change") {
				await postRewrap({
					passphrase: await buildReplacement({
						userId,
						privateKey,
						secret: next,
						purpose: "passphrase",
						version,
						previousWrapped: identity.passphraseWrapped,
						derive: deriver.derive,
					}),
					formatVersion: version,
				});
				// The stored wrap moved, so the context copy the next rewrap would
				// use as its compare-and-set token is now stale.
				await refresh();
				setPane("done");
				return;
			}

			const recoveryIdentity = await fetchRecoveryIdentity();
			if (!recoveryIdentity.recoveryWrapped) {
				throw new RewrapError("failed", "passphrase: no recovery wrap");
			}
			const recovery = await generateRecoveryCode();
			await postRewrap({
				recovery: await buildReplacement({
					userId,
					privateKey,
					secret: recovery.canonical,
					purpose: "recovery",
					version,
					previousWrapped: recoveryIdentity.recoveryWrapped,
					derive: deriver.derive,
				}),
				formatVersion: version,
			});
			setIssued({ display: recovery.display, canonical: recovery.canonical });
			setPane("display");
		} catch (caught) {
			if (caught instanceof KeyringError) {
				setError(
					caught.reason === "stale"
						? m.e2e_unlock_stale()
						: m.e2e_unlock_wrong_passphrase(),
				);
			} else {
				console.error(caught);
				setError(
					caught instanceof RewrapError && caught.reason === "conflict"
						? m.e2e_rewrap_conflict()
						: m.e2e_rewrap_failed(),
				);
			}
		} finally {
			setBusy(false);
		}
	}

	async function confirmIssued(): Promise<void> {
		if (busy || !issued) return;
		let canonical: string;
		try {
			canonical = await normaliseRecoveryCode(typed);
		} catch (caught) {
			setConfirmError(
				caught instanceof RecoveryCodeError && caught.reason === "checksum"
					? m.e2e_recovery_confirm_checksum()
					: m.e2e_recovery_confirm_mismatch(),
			);
			return;
		}
		if (canonical !== issued.canonical) {
			setConfirmError(m.e2e_recovery_confirm_mismatch());
			return;
		}
		setConfirmError(null);
		setPane("done");
	}

	// The new code is live the moment the rewrap lands, so the display pane
	// cannot be dismissed: leaving it would strand the user with the only
	// working code unseen.
	const dismissable = pane !== "display";

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value && !dismissable) return;
				onOpenChange(value);
			}}
		>
			<DialogContent data-testid={`e2e-${mode}-dialog`}>
				{pane === "verify" && (
					<>
						<DialogHeader>
							<DialogTitle>
								{mode === "change"
									? m.e2e_change_passphrase()
									: m.e2e_regenerate_recovery()}
							</DialogTitle>
							{mode === "regenerate" && (
								<DialogDescription data-testid="e2e-regenerate-warning">
									{m.e2e_regenerate_warning()}
								</DialogDescription>
							)}
						</DialogHeader>

						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5">
								<label htmlFor={currentId} className="text-sm font-medium">
									{m.e2e_field_current_passphrase()}
								</label>
								<Input
									id={currentId}
									data-testid="e2e-current-passphrase"
									type="password"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									value={current}
									onChange={(event) => setCurrent(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter" && mode === "regenerate") {
											void submitVerify();
										}
									}}
								/>
							</div>

							{mode === "change" && (
								<>
									<div className="flex flex-col gap-1.5">
										<label htmlFor={nextId} className="text-sm font-medium">
											{m.e2e_field_passphrase()}
										</label>
										<Input
											id={nextId}
											data-testid="e2e-new-passphrase"
											type="password"
											autoComplete="off"
											autoCapitalize="off"
											spellCheck={false}
											value={next}
											onChange={(event) => setNext(event.target.value)}
										/>
									</div>
									<div className="flex flex-col gap-1.5">
										<label htmlFor={confirmId} className="text-sm font-medium">
											{m.e2e_field_passphrase_confirm()}
										</label>
										<Input
											id={confirmId}
											data-testid="e2e-new-passphrase-confirm"
											type="password"
											autoComplete="off"
											autoCapitalize="off"
											spellCheck={false}
											value={confirmNext}
											onChange={(event) => setConfirmNext(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter") void submitVerify();
											}}
										/>
									</div>
								</>
							)}

							{error && (
								<p
									role="alert"
									data-testid="e2e-passphrase-dialog-error"
									className="text-sm text-destructive"
								>
									{error}
								</p>
							)}

							<Button
								type="button"
								className="self-end"
								data-testid="e2e-passphrase-dialog-submit"
								disabled={
									busy ||
									!current ||
									(mode === "change" && (!next || !confirmNext))
								}
								onClick={() => void submitVerify()}
							>
								{busy
									? m.e2e_enroll_working()
									: mode === "change"
										? m.e2e_recovery_reset_submit()
										: m.e2e_regenerate_recovery()}
							</Button>
						</div>
					</>
				)}

				{pane === "display" && issued && (
					<>
						<DialogHeader>
							<DialogTitle>{m.e2e_recovery_heading()}</DialogTitle>
							<DialogDescription>{m.e2e_recovery_intro()}</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							<RecoveryCodeCard display={issued.display} allowDownload />

							<p
								data-testid="e2e-regenerate-must-confirm"
								className="text-sm font-medium"
							>
								{m.e2e_recovery_must_confirm()}
							</p>

							<div className="flex flex-col gap-1.5">
								<label htmlFor={typedId} className="text-sm font-medium">
									{m.e2e_recovery_confirm_label()}
								</label>
								<Input
									id={typedId}
									data-testid="e2e-regenerate-confirm"
									dir="ltr"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									value={typed}
									onChange={(event) => setTyped(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void confirmIssued();
									}}
								/>
							</div>

							{confirmError && (
								<p
									role="alert"
									data-testid="e2e-regenerate-confirm-error"
									className="text-sm text-destructive"
								>
									{confirmError}
								</p>
							)}

							<Button
								type="button"
								className="self-end"
								data-testid="e2e-regenerate-confirm-submit"
								disabled={!typed}
								onClick={() => void confirmIssued()}
							>
								{m.e2e_recovery_confirm_submit()}
							</Button>
						</div>
					</>
				)}

				{pane === "done" && (
					<>
						<DialogHeader>
							<DialogTitle>
								{mode === "change"
									? m.e2e_change_passphrase()
									: m.e2e_regenerate_recovery()}
							</DialogTitle>
							<DialogDescription data-testid="e2e-passphrase-dialog-done">
								{mode === "change"
									? m.e2e_change_passphrase_done()
									: m.e2e_regenerate_done()}
							</DialogDescription>
						</DialogHeader>
						<Button
							type="button"
							className="self-end"
							data-testid="e2e-passphrase-dialog-close"
							onClick={() => onOpenChange(false)}
						>
							{m.e2e_enroll_done_close()}
						</Button>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
