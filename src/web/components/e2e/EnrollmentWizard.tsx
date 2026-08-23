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
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { generateIdentityKeyPair } from "../../../domain/e2e/hpke.ts";
import { CURRENT_KDF_VERSION, generateSalt } from "../../../domain/e2e/kdf.ts";
import {
	generateRecoveryCode,
	normaliseRecoveryCode,
	RecoveryCodeError,
} from "../../../domain/e2e/recovery-code.ts";
import { encodeBytes, encodeWrapped } from "../../../domain/e2e/wire.ts";
import { m } from "../../../paraglide/messages.js";
import { createDeriver } from "../../lib/e2e/derive.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { RecoveryCodeCard } from "./RecoveryCodeCard.tsx";

// Design 3.1 / shell flow 1. A floor, not a strength meter: a meter invites
// gaming a green bar, a floor is honest about being a floor.
export const MIN_PASSPHRASE_LENGTH = 12;

type Pane = "passphrase" | "recovery" | "done";

// Held together because they are produced together on entering pane 2 and are
// only ever posted as a set. Splitting them into separate state let a retry
// re-derive one half against the other's salt during development.
type Material = {
	publicKey: string;
	passphraseWrapped: string;
	recoveryWrapped: string;
	passphraseSalt: string;
	recoverySalt: string;
	formatVersion: number;
	display: string;
	canonical: string;
	// Kept for the handover to the keyring on the done pane. It never leaves
	// this component and is dropped with the rest of the material on reset.
	privateKey: Uint8Array;
};

export function EnrollmentWizard({
	open,
	onOpenChange,
	userId,
	onEnrolled,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	userId: string;
	/**
	 * Runs once the identity is committed. Gate C attaches the pending file
	 * here: the wizard's job ends at enrollment, and the parent surface owns
	 * the upload so closing the dialog never cancels it.
	 */
	onEnrolled?: () => void;
}) {
	const { adoptPrivateKey } = useKeyring();
	const [pane, setPane] = useState<Pane>("passphrase");
	const [passphrase, setPassphrase] = useState("");
	const [confirmPassphrase, setConfirmPassphrase] = useState("");
	const [passphraseError, setPassphraseError] = useState<string | null>(null);
	const [typed, setTyped] = useState("");
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	const [enrollError, setEnrollError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [material, setMaterial] = useState<Material | null>(null);

	const passphraseId = useId();
	const confirmId = useId();
	const typedId = useId();

	// One worker for the dialog's lifetime. Created lazily inside the deriver,
	// so opening the dialog does not spawn one until Continue is pressed.
	const deriver = useMemo(() => createDeriver(), []);
	useEffect(() => () => deriver.dispose(), [deriver]);

	function reset() {
		setPane("passphrase");
		setPassphrase("");
		setConfirmPassphrase("");
		setPassphraseError(null);
		setTyped("");
		setRecoveryError(null);
		setEnrollError(null);
		setBusy(false);
		// Abandoning at pane 2 discards a code that was never authoritative --
		// nothing is persisted until pane 3, so there is no half-enrolled state.
		setMaterial(null);
	}

	async function buildMaterial(): Promise<void> {
		if (busy) return;
		if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
			setPassphraseError(m.e2e_passphrase_too_short());
			return;
		}
		if (passphrase !== confirmPassphrase) {
			setPassphraseError(m.e2e_passphrase_mismatch());
			return;
		}
		setPassphraseError(null);
		setBusy(true);
		try {
			const identity = await generateIdentityKeyPair();
			const recovery = await generateRecoveryCode();
			const passphraseSalt = generateSalt();
			const recoverySalt = generateSalt();

			// Independent salts and a purpose-separated secret, so reusing the
			// same string for both wraps still yields two unrelated KEKs.
			const passphraseKek = await deriver.derive(
				passphrase,
				passphraseSalt,
				"passphrase",
				CURRENT_KDF_VERSION,
			);
			const recoveryKek = await deriver.derive(
				recovery.canonical,
				recoverySalt,
				"recovery",
				CURRENT_KDF_VERSION,
			);

			setMaterial({
				publicKey: encodeBytes(identity.publicKey),
				passphraseWrapped: encodeWrapped(
					await encryptWrapped(
						identity.privateKey,
						passphraseKek,
						aad.privateKeyPassphrase(userId),
					),
				),
				recoveryWrapped: encodeWrapped(
					await encryptWrapped(
						identity.privateKey,
						recoveryKek,
						aad.privateKeyRecovery(userId),
					),
				),
				passphraseSalt: encodeBytes(passphraseSalt),
				recoverySalt: encodeBytes(recoverySalt),
				// The version this client actually derived under, sent rather than
				// assumed by the server: a wrap recorded under a version it was not
				// made with never opens again.
				formatVersion: CURRENT_KDF_VERSION,
				display: recovery.display,
				canonical: recovery.canonical,
				privateKey: identity.privateKey,
			});
			setPane("recovery");
		} catch (error) {
			console.error(error);
			setPassphraseError(m.e2e_enroll_failed());
		} finally {
			setBusy(false);
		}
	}

	async function confirmAndEnroll(): Promise<void> {
		if (busy || !material) return;
		let canonical: string;
		try {
			// Checksum first, so a single mistyped character says so instead of
			// surfacing as the generic mismatch.
			canonical = await normaliseRecoveryCode(typed);
		} catch (error) {
			setRecoveryError(
				error instanceof RecoveryCodeError && error.reason === "checksum"
					? m.e2e_recovery_confirm_checksum()
					: m.e2e_recovery_confirm_mismatch(),
			);
			return;
		}
		if (canonical !== material.canonical) {
			setRecoveryError(m.e2e_recovery_confirm_mismatch());
			return;
		}
		setRecoveryError(null);
		await submit(material);
	}

	async function submit(current: Material): Promise<void> {
		setBusy(true);
		setEnrollError(null);
		try {
			const response = await fetch("/api/e2e/enroll", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					publicKey: current.publicKey,
					passphraseWrapped: current.passphraseWrapped,
					recoveryWrapped: current.recoveryWrapped,
					passphraseSalt: current.passphraseSalt,
					recoverySalt: current.recoverySalt,
					formatVersion: current.formatVersion,
				}),
			});
			if (!response.ok) {
				setEnrollError(m.e2e_enroll_failed());
				setPane("done");
				return;
			}
			setPane("done");
			// The private key is already in hand here, so enrollment leaves the
			// device unlocked and remembered rather than immediately prompting
			// for the passphrase that was typed two panes ago.
			await adoptPrivateKey(current.privateKey, true);
			onEnrolled?.();
		} catch (error) {
			console.error(error);
			setEnrollError(m.e2e_enroll_failed());
			setPane("done");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) reset();
				onOpenChange(next);
			}}
		>
			<DialogContent data-testid="e2e-enroll-dialog">
				{pane === "passphrase" && (
					<>
						<DialogHeader>
							<DialogTitle>{m.e2e_enroll_title()}</DialogTitle>
							<DialogDescription>{m.e2e_enroll_intro()}</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							<h3 className="text-sm font-medium">
								{m.e2e_enroll_passphrase_heading()}
							</h3>
							<p className="text-sm text-muted-foreground">
								{m.e2e_enroll_not_account_password()}
							</p>
							{/*
							  Full contrast and body text, never muted and never a
							  footnote: design record is explicit that this sentence
							  must not be softened.
							*/}
							<p
								data-testid="e2e-no-reset-note"
								className="text-sm font-medium"
							>
								{m.e2e_no_reset_note()}
							</p>

							<div className="flex flex-col gap-1.5">
								<label htmlFor={passphraseId} className="text-sm font-medium">
									{m.e2e_field_passphrase()}
								</label>
								{/*
								  Deliberately NOT autocomplete="new-password": a password
								  manager offering to overwrite the ACCOUNT password here is
								  exactly the confusion the copy above is fighting.
								*/}
								<Input
									id={passphraseId}
									data-testid="e2e-passphrase"
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
									data-testid="e2e-passphrase-confirm"
									type="password"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									value={confirmPassphrase}
									onChange={(event) => setConfirmPassphrase(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void buildMaterial();
									}}
								/>
							</div>

							{passphraseError && (
								<p
									role="alert"
									data-testid="e2e-passphrase-error"
									className="text-sm text-destructive"
								>
									{passphraseError}
								</p>
							)}

							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									data-testid="e2e-enroll-cancel"
									onClick={() => onOpenChange(false)}
								>
									{m.e2e_enroll_cancel()}
								</Button>
								<Button
									type="button"
									data-testid="e2e-enroll-continue"
									disabled={busy || !passphrase || !confirmPassphrase}
									onClick={() => void buildMaterial()}
								>
									{busy ? m.e2e_enroll_working() : m.action_continue()}
								</Button>
							</div>
						</div>
					</>
				)}

				{pane === "recovery" && material && (
					<>
						<DialogHeader>
							<DialogTitle>{m.e2e_recovery_heading()}</DialogTitle>
							<DialogDescription>{m.e2e_recovery_intro()}</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							{/* Focuses itself on mount, per the shell's focus order. */}
							<RecoveryCodeCard display={material.display} allowDownload />

							<div className="flex flex-col gap-1.5">
								<label htmlFor={typedId} className="text-sm font-medium">
									{m.e2e_recovery_confirm_label()}
								</label>
								{/*
								  Re-entry, not a checkbox. "I saved it" is theater; the code's
								  whole value is existing outside this browser, and a paste
								  round-trip is the only evidence available that it left.
								*/}
								<Input
									id={typedId}
									data-testid="e2e-recovery-confirm"
									dir="ltr"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									value={typed}
									onChange={(event) => setTyped(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void confirmAndEnroll();
									}}
								/>
							</div>

							{recoveryError && (
								<p
									role="alert"
									data-testid="e2e-recovery-error"
									className="text-sm text-destructive"
								>
									{recoveryError}
								</p>
							)}

							<Button
								type="button"
								className="self-end"
								data-testid="e2e-recovery-submit"
								disabled={busy || !typed}
								onClick={() => void confirmAndEnroll()}
							>
								{busy
									? m.e2e_enroll_working()
									: m.e2e_recovery_confirm_submit()}
							</Button>
						</div>
					</>
				)}

				{pane === "done" && (
					<>
						<DialogHeader>
							<DialogTitle>{m.e2e_enroll_done_heading()}</DialogTitle>
							<DialogDescription>{m.e2e_enroll_done_body()}</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-3">
							{enrollError ? (
								<>
									<p
										role="alert"
										data-testid="e2e-enroll-error"
										className="text-sm text-destructive"
									>
										{enrollError}
									</p>
									{/*
									  Retry re-posts the SAME wraps. The endpoint is idempotent,
									  so the code from pane 2 stays valid and the user is never
									  handed a second one.
									*/}
									<Button
										type="button"
										data-testid="e2e-enroll-retry"
										disabled={busy || !material}
										onClick={() => material && void submit(material)}
									>
										{m.action_retry()}
									</Button>
								</>
							) : (
								<Button
									type="button"
									className="self-end"
									data-testid="e2e-enroll-close"
									onClick={() => onOpenChange(false)}
								>
									{m.e2e_enroll_done_close()}
								</Button>
							)}
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
