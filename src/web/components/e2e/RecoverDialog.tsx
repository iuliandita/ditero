import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
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
	openRecoveryWrap,
	postRewrap,
	RewrapError,
} from "../../lib/e2e/rewrap.ts";
import { MIN_PASSPHRASE_LENGTH } from "./EnrollmentWizard.tsx";
import { RecoveryCodeCard } from "./RecoveryCodeCard.tsx";

type Pane = "code" | "reset" | "display";

// Shell flow 3. Panes, not a dialog of its own: a user who has just failed a
// passphrase must not lose the surface they were on, so this renders inside
// the unlock dialog that offered it.
export function RecoverDialog({
	userId,
	onDismissable,
	onDone,
}: {
	userId: string;
	/**
	 * Reports whether the host dialog may be closed. False from the moment the
	 * rewrap lands: the new code is already the only one that works, so leaving
	 * before confirming it strands the user with a code they never saw.
	 */
	onDismissable: (dismissable: boolean) => void;
	onDone: () => void;
}) {
	const { adoptPrivateKey, identity } = useKeyring();
	const [pane, setPane] = useState<Pane>("code");
	const [code, setCode] = useState("");
	const [codeError, setCodeError] = useState<string | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [confirmPassphrase, setConfirmPassphrase] = useState("");
	const [resetError, setResetError] = useState<string | null>(null);
	const [typed, setTyped] = useState("");
	const [confirmError, setConfirmError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null);
	// Captured on the pane that opened it, and used as the compare-and-set
	// token on the next pane. Re-reading it there would defeat the check: it
	// would fetch whatever the row holds now, which is what the check exists
	// to notice has changed.
	const [previousRecovery, setPreviousRecovery] = useState<string | null>(null);
	const [issued, setIssued] = useState<{
		display: string;
		canonical: string;
	} | null>(null);

	const codeId = useId();
	const passphraseId = useId();
	const confirmId = useId();
	const typedId = useId();

	const deriver = useMemo(() => createDeriver(), []);
	useEffect(() => () => deriver.dispose(), [deriver]);

	useEffect(() => {
		onDismissable(pane !== "display");
	}, [pane, onDismissable]);

	async function submitCode(): Promise<void> {
		if (busy || !code) return;
		setBusy(true);
		setCodeError(null);
		try {
			// Checksum first, so a mistyped character fails in milliseconds
			// instead of paying the Argon2 derivation to say the same thing.
			const canonical = await normaliseRecoveryCode(code);
			const recoveryIdentity = await fetchRecoveryIdentity();
			setPrivateKey(
				await openRecoveryWrap({
					userId,
					identity: recoveryIdentity,
					code: canonical,
					derive: deriver.derive,
				}),
			);
			setPreviousRecovery(recoveryIdentity.recoveryWrapped);
			setPane("reset");
		} catch (error) {
			if (error instanceof RecoveryCodeError) {
				setCodeError(
					error.reason === "checksum"
						? m.e2e_recovery_confirm_checksum()
						: m.e2e_recovery_wrong(),
				);
			} else if (error instanceof KeyringError && error.reason === "stale") {
				setCodeError(m.e2e_unlock_stale());
			} else {
				setCodeError(m.e2e_recovery_wrong());
			}
		} finally {
			setBusy(false);
		}
	}

	async function submitReset(): Promise<void> {
		if (busy || !privateKey) return;
		if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
			setResetError(m.e2e_passphrase_too_short());
			return;
		}
		if (passphrase !== confirmPassphrase) {
			setResetError(m.e2e_passphrase_mismatch());
			return;
		}
		setBusy(true);
		setResetError(null);
		try {
			// Both secrets are replaced, mandatorily. Someone here has just
			// demonstrated they do not know their passphrase, and the code they
			// used has passed through a text field and possibly a clipboard;
			// leaving either in place keeps one secret nobody should trust.
			const recovery = await generateRecoveryCode();
			const version = identity?.formatVersion ?? CURRENT_KDF_VERSION;
			if (!identity?.passphraseWrapped || !previousRecovery) {
				throw new RewrapError("failed", "recover: identity is incomplete");
			}
			await postRewrap({
				passphrase: await buildReplacement({
					userId,
					privateKey,
					secret: passphrase,
					purpose: "passphrase",
					version,
					previousWrapped: identity.passphraseWrapped,
					derive: deriver.derive,
				}),
				recovery: await buildReplacement({
					userId,
					privateKey,
					secret: recovery.canonical,
					purpose: "recovery",
					version,
					previousWrapped: previousRecovery,
					derive: deriver.derive,
				}),
				formatVersion: version,
			});
			setIssued({ display: recovery.display, canonical: recovery.canonical });
			setPane("display");
		} catch (error) {
			console.error(error);
			setResetError(
				error instanceof RewrapError && error.reason === "conflict"
					? m.e2e_rewrap_conflict()
					: m.e2e_rewrap_failed(),
			);
		} finally {
			setBusy(false);
		}
	}

	async function confirmIssued(): Promise<void> {
		if (busy || !issued || !privateKey) return;
		let canonical: string;
		try {
			canonical = await normaliseRecoveryCode(typed);
		} catch (error) {
			setConfirmError(
				error instanceof RecoveryCodeError && error.reason === "checksum"
					? m.e2e_recovery_confirm_checksum()
					: m.e2e_recovery_confirm_mismatch(),
			);
			return;
		}
		if (canonical !== issued.canonical) {
			setConfirmError(m.e2e_recovery_confirm_mismatch());
			return;
		}
		setBusy(true);
		// The key is in hand and the wraps are already the new ones, so the
		// device ends unlocked rather than prompting for the passphrase that
		// was typed one pane ago.
		await adoptPrivateKey(privateKey, true);
		setBusy(false);
		onDone();
	}

	return (
		<>
			{pane === "code" && (
				<>
					<DialogHeader>
						<DialogTitle>{m.e2e_recovery_title()}</DialogTitle>
						<DialogDescription>
							{m.e2e_recovery_description()}
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={codeId} className="text-sm font-medium">
								{m.e2e_recovery_field()}
							</label>
							{/*
							  dir="ltr" for the same reason the code block carries it:
							  the group order is load-bearing and an RTL locale would
							  render a typed code back to front.
							*/}
							<Input
								id={codeId}
								data-testid="e2e-recover-code"
								dir="ltr"
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								value={code}
								onChange={(event) => setCode(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void submitCode();
								}}
							/>
						</div>

						{codeError && (
							<p
								role="alert"
								data-testid="e2e-recover-error"
								className="text-sm text-destructive"
							>
								{codeError}
							</p>
						)}

						<Button
							type="button"
							className="self-end"
							data-testid="e2e-recover-submit"
							disabled={busy || !code}
							onClick={() => void submitCode()}
						>
							{busy ? m.e2e_unlock_working() : m.e2e_recovery_submit()}
						</Button>
					</div>
				</>
			)}

			{pane === "reset" && (
				<>
					<DialogHeader>
						<DialogTitle>{m.e2e_recovery_reset_heading()}</DialogTitle>
						<DialogDescription>
							{m.e2e_recovery_reset_intro()}
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={passphraseId} className="text-sm font-medium">
								{m.e2e_field_passphrase()}
							</label>
							<Input
								id={passphraseId}
								data-testid="e2e-recover-passphrase"
								type="password"
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								value={passphrase}
								onChange={(event) => setPassphrase(event.target.value)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor={confirmId} className="text-sm font-medium">
								{m.e2e_field_passphrase_confirm()}
							</label>
							<Input
								id={confirmId}
								data-testid="e2e-recover-passphrase-confirm"
								type="password"
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								value={confirmPassphrase}
								onChange={(event) => setConfirmPassphrase(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void submitReset();
								}}
							/>
						</div>

						{resetError && (
							<p
								role="alert"
								data-testid="e2e-recover-reset-error"
								className="text-sm text-destructive"
							>
								{resetError}
							</p>
						)}

						<Button
							type="button"
							className="self-end"
							data-testid="e2e-recover-reset-submit"
							disabled={busy || !passphrase || !confirmPassphrase}
							onClick={() => void submitReset()}
						>
							{busy ? m.e2e_enroll_working() : m.e2e_recovery_reset_submit()}
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

						{/*
						  The only non-dismissible pane in the milestone, and it says
						  so rather than letting a blocked Escape read as a bug.
						*/}
						<p
							data-testid="e2e-recover-must-confirm"
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
								data-testid="e2e-recover-confirm"
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
								data-testid="e2e-recover-confirm-error"
								className="text-sm text-destructive"
							>
								{confirmError}
							</p>
						)}

						<Button
							type="button"
							className="self-end"
							data-testid="e2e-recover-confirm-submit"
							disabled={busy || !typed}
							onClick={() => void confirmIssued()}
						>
							{m.e2e_recovery_confirm_submit()}
						</Button>
					</div>
				</>
			)}
		</>
	);
}
