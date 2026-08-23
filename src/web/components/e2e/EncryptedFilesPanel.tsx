import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	AUTO_LOCK_CHOICES,
	type AutoLockMinutes,
	DEFAULT_AUTO_LOCK_MINUTES,
} from "../../../domain/e2e/auto-lock.ts";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { EnrollmentWizard } from "./EnrollmentWizard.tsx";
import {
	PassphraseDialog,
	type PassphraseDialogMode,
} from "./PassphraseDialog.tsx";
import { UnlockDialog } from "./UnlockDialog.tsx";

// Discrete keys rather than a number plus a unit, so no locale has to inflect
// a duration against a user-entered integer.
const AUTO_LOCK_LABEL: Record<AutoLockMinutes, () => string> = {
	15: m.e2e_autolock_15m,
	60: m.e2e_autolock_1h,
	480: m.e2e_autolock_8h,
	0: m.e2e_autolock_never,
};

// Shell section 9.
export function EncryptedFilesPanel({ userId }: { userId: string }) {
	const { state, ready, available, lockNow } = useKeyring();
	const { pref, setPref } = useUserPref();
	const [enrolling, setEnrolling] = useState(false);
	const [unlocking, setUnlocking] = useState(false);
	const [announceLock, setAnnounceLock] = useState(false);
	const [rewrapping, setRewrapping] = useState<PassphraseDialogMode | null>(
		null,
	);

	// Nothing at all while the deployment has the feature off, and nothing until
	// the first identity fetch settles -- a flash of "not set up" for an enrolled
	// user is worse than a moment of nothing.
	if (!available || !ready) return null;

	const autoLock = pref.e2eAutoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;

	return (
		<section className="mt-4" aria-labelledby="e2e-heading">
			<h3 id="e2e-heading" className="text-sm font-medium">
				{m.e2e_settings_heading()}
			</h3>

			{state === "unenrolled" && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
					<span data-testid="e2e-status" className="text-sm">
						{m.e2e_status_unenrolled()}
					</span>
					<Button
						type="button"
						variant="outline"
						data-testid="e2e-setup"
						onClick={() => setEnrolling(true)}
					>
						{m.e2e_setup_action()}
					</Button>
				</div>
			)}

			{state === "locked" && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
					<span data-testid="e2e-status" className="text-sm">
						{m.e2e_status_locked()}
					</span>
					<Button
						type="button"
						variant="outline"
						data-testid="e2e-unlock"
						onClick={() => setUnlocking(true)}
					>
						{m.e2e_unlock_submit()}
					</Button>
				</div>
			)}

			{state === "ready" && (
				<div className="mt-2 flex flex-col gap-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span data-testid="e2e-status" className="text-sm">
							{m.e2e_status_ready()}
						</span>
						{/*
						  No confirm. Locking is cheap to undo, and confirming a safety
						  action teaches people to click through safety actions.
						*/}
						<Button
							type="button"
							variant="outline"
							data-testid="e2e-lock-now"
							onClick={() => {
								lockNow();
								setAnnounceLock(true);
							}}
						>
							{m.e2e_lock_now()}
						</Button>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">
							{m.e2e_autolock_label()}
						</span>
						<Select
							value={String(autoLock)}
							onValueChange={(next) =>
								setPref({
									e2eAutoLockMinutes: Number(next) as AutoLockMinutes,
								})
							}
						>
							<SelectTrigger
								aria-label={m.e2e_autolock_label()}
								data-testid="e2e-autolock"
								className="w-full"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{AUTO_LOCK_CHOICES.map((minutes) => (
									<SelectItem key={minutes} value={String(minutes)}>
										{AUTO_LOCK_LABEL[minutes]()}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/*
					  Both demand the current passphrase, so neither is reachable
					  from a browser that merely holds a stored key. They live
					  beside the auto-lock control rather than behind an "advanced"
					  disclosure: a recovery code people cannot find is one they
					  will not replace after it leaks.
					*/}
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							data-testid="e2e-change-passphrase"
							onClick={() => setRewrapping("change")}
						>
							{m.e2e_change_passphrase()}
						</Button>
						<Button
							type="button"
							variant="outline"
							data-testid="e2e-regenerate-recovery"
							onClick={() => setRewrapping("regenerate")}
						>
							{m.e2e_regenerate_recovery()}
						</Button>
					</div>

					{/*
					  Repeated verbatim from the wizard, and the only string in the
					  milestone deliberately shown twice: it is the one sentence a user
					  is most likely to want to re-read.
					*/}
					<p
						data-testid="e2e-no-reset-note-settings"
						className="text-sm font-medium"
					>
						{m.e2e_no_reset_note()}
					</p>
				</div>
			)}

			<span role="status" className="sr-only">
				{announceLock && state === "locked" && m.e2e_locked_announcement()}
			</span>

			<EnrollmentWizard
				open={enrolling}
				onOpenChange={setEnrolling}
				userId={userId}
			/>
			<UnlockDialog
				open={unlocking}
				onOpenChange={setUnlocking}
				userId={userId}
			/>
			{rewrapping && (
				<PassphraseDialog
					mode={rewrapping}
					open
					onOpenChange={(next) => {
						if (!next) setRewrapping(null);
					}}
					userId={userId}
				/>
			)}
		</section>
	);
}
