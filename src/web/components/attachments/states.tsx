import { useQuery, useZero } from "@rocicorp/zero/react";
import { KeyRound, LoaderCircle, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { encryptedStreamLength } from "../../../domain/e2e/stream.ts";
import { ADMIN_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import {
	fetchAttachmentConfig,
	type MyAttachmentGrant,
} from "../../lib/e2e/attachment-api.ts";
import {
	useKeyring,
	type WorkspaceKeyMaterial,
} from "../../lib/e2e/KeyringProvider.tsx";
import { AttachmentUploadError } from "../../lib/e2e/upload.ts";
import {
	fetchWorkspaceRotationPlan,
	rotateWorkspaceKey,
	type WorkspaceRotationPlan,
} from "../../lib/e2e/workspace-keys.ts";
import { formatBytes, formatList } from "../../lib/intl-format.ts";
import { EnrollmentWizard } from "../e2e/EnrollmentWizard.tsx";
import { UnlockDialog } from "../e2e/UnlockDialog.tsx";

type ReadyAction = (
	key: WorkspaceKeyMaterial,
	files: File[],
) => void | Promise<void>;
type PendingAction = {
	files: File[];
	keyVersion?: number;
	action: ReadyAction;
};

export type AttachmentGateController = {
	blocked: boolean;
	error: string | null;
	clearError: () => void;
	runWithFiles: (files: File[], action: ReadyAction) => Promise<boolean>;
	runWithKey: (keyVersion: number, action: ReadyAction) => Promise<boolean>;
	reportUploadFailure: (error: unknown) => void;
	rotationPlan: WorkspaceRotationPlan | null;
	rotationBusy: boolean;
	rotate: () => Promise<boolean>;
	focusBlocked: boolean;
	focusBlockedSurface: () => void;
	consumeBlockedFocus: () => void;
	userId: string;
	enrolling: boolean;
	setEnrolling: (open: boolean) => void;
	cancelEnrollment: () => void;
	unlocking: boolean;
	setUnlocking: (open: boolean) => void;
	resume: () => Promise<void>;
	announcement: string;
	pendingFileName: string | null;
};

function displayNames(names: string[]): string {
	if (names.length <= 3) return formatList(names);
	return `${formatList(names.slice(0, 3), "unit")} ${m.e2e_grant_who_overflow({ count: names.length - 3 })}`;
}

export function useAttachmentGate(
	workspaceId: string,
): AttachmentGateController {
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const keyring = useKeyring();
	const workspace = workspaces.find((row) => row.id === workspaceId);
	const [enrolling, setEnrolling] = useState(false);
	const [unlocking, setUnlocking] = useState(false);
	const [serverBlocked, setServerBlocked] = useState(false);
	const [rotationCleared, setRotationCleared] = useState(false);
	const [rotationPlan, setRotationPlan] =
		useState<WorkspaceRotationPlan | null>(null);
	const [rotationBusy, setRotationBusy] = useState(false);
	const [focusBlocked, setFocusBlocked] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [pendingFileName, setPendingFileName] = useState<string | null>(null);
	const pending = useRef<PendingAction | null>(null);
	const maxFileBytes = useRef<number | null>(null);
	const blocked =
		Boolean(workspace?.rotationRequired || serverBlocked) && !rotationCleared;

	useEffect(() => {
		if (!workspace?.rotationRequired && !serverBlocked)
			setRotationCleared(false);
	}, [serverBlocked, workspace?.rotationRequired]);

	useEffect(() => {
		if (!blocked) {
			setRotationPlan(null);
			return;
		}
		let active = true;
		void fetchWorkspaceRotationPlan(workspaceId)
			.then((plan) => {
				if (active) setRotationPlan(plan);
			})
			.catch((caught: unknown) => {
				console.error("attachments: rotation plan failed", caught);
				if (active) setError(m.e2e_rotation_failed());
			});
		return () => {
			active = false;
		};
	}, [blocked, workspaceId]);

	const continueWithKey = useCallback(
		async (current: PendingAction): Promise<boolean> => {
			let key = await keyring.workspaceKey(workspaceId, current.keyVersion);
			if (!key) {
				await keyring.refreshWorkspaceKeys();
				key = await keyring.workspaceKey(workspaceId, current.keyVersion);
			}
			if (!key) {
				setError(m.attachment_key_pending());
				return false;
			}
			pending.current = null;
			await current.action(key, current.files);
			return true;
		},
		[keyring, workspaceId],
	);

	const begin = useCallback(
		async (current: PendingAction): Promise<boolean> => {
			setError(null);
			pending.current = current;
			setPendingFileName(current.files[0]?.name ?? null);
			if (blocked) {
				setFocusBlocked(true);
				return false;
			}
			if (keyring.state === "unenrolled") {
				setEnrolling(true);
				return false;
			}
			if (keyring.state === "locked") {
				setUnlocking(true);
				return false;
			}
			return await continueWithKey(current);
		},
		[blocked, continueWithKey, keyring.state],
	);

	const runWithFiles = useCallback(
		async (files: File[], action: ReadyAction): Promise<boolean> => {
			if (files.length === 0) return false;
			if (typeof navigator !== "undefined" && !navigator.onLine) {
				setError(m.attachment_error_offline());
				return false;
			}
			let limit: number;
			try {
				limit = (await fetchAttachmentConfig()).maxFileBytes;
				maxFileBytes.current = limit;
			} catch (caught) {
				console.error("attachments: config failed", caught);
				setError(m.attachment_error_reserve_failed());
				return false;
			}
			if (files.some((file) => encryptedStreamLength(file.size) > limit)) {
				setError(m.attachment_error_too_large({ limit: formatBytes(limit) }));
				return false;
			}
			return await begin({ files, action });
		},
		[begin],
	);

	const runWithKey = useCallback(
		(keyVersion: number, action: ReadyAction) =>
			begin({ files: [], keyVersion, action }),
		[begin],
	);

	const resume = useCallback(async () => {
		const current = pending.current;
		if (!current) return;
		await continueWithKey(current);
	}, [continueWithKey]);

	const reportUploadFailure = useCallback((caught: unknown) => {
		if (typeof navigator !== "undefined" && !navigator.onLine) {
			setError(m.attachment_error_offline());
			return;
		}
		if (
			caught instanceof AttachmentUploadError &&
			caught.reason === "rotation-required"
		) {
			setServerBlocked(true);
			setRotationCleared(false);
			setFocusBlocked(true);
			setError(m.attachment_error_rotation_required());
			return;
		}
		if (caught instanceof AttachmentUploadError) {
			if (caught.reason === "file-too-large") {
				setError(
					maxFileBytes.current === null
						? m.attachment_error_reserve_failed()
						: m.attachment_error_too_large({
								limit: formatBytes(maxFileBytes.current),
							}),
				);
				return;
			}
			if (caught.reason === "quota-exceeded") {
				setError(m.attachment_error_quota());
				return;
			}
			if (caught.reason === "key-unavailable") {
				setError(m.attachment_key_pending());
				return;
			}
		}
		setError(
			caught instanceof AttachmentUploadError && caught.stage === "reserve"
				? m.attachment_error_reserve_failed()
				: m.attachment_error_upload_failed(),
		);
	}, []);
	const cancelEnrollment = useCallback(() => {
		pending.current = null;
		setPendingFileName(null);
		setError(m.e2e_enroll_discard_notice());
	}, []);

	const rotate = useCallback(async () => {
		if (rotationBusy) return false;
		setRotationBusy(true);
		setError(null);
		try {
			const result = await rotateWorkspaceKey(workspaceId);
			if (result.wdk) {
				keyring.cacheWorkspaceKey(workspaceId, result.version, result.wdk);
			}
			await keyring.refreshWorkspaceKeys();
			setRotationCleared(true);
			setServerBlocked(false);
			setAnnouncement(
				result.outcome === "already"
					? m.e2e_rotation_already_done()
					: m.e2e_rotation_done(),
			);
			await resume();
			return true;
		} catch (caught) {
			console.error("attachments: rotation failed", caught);
			setError(m.e2e_rotation_failed());
			return false;
		} finally {
			setRotationBusy(false);
		}
	}, [keyring, resume, rotationBusy, workspaceId]);

	return useMemo(
		() => ({
			blocked,
			error,
			clearError: () => setError(null),
			runWithFiles,
			runWithKey,
			reportUploadFailure,
			rotationPlan,
			rotationBusy,
			rotate,
			focusBlocked,
			focusBlockedSurface: () => setFocusBlocked(true),
			consumeBlockedFocus: () => setFocusBlocked(false),
			userId: zero.userID ?? "",
			enrolling,
			setEnrolling,
			cancelEnrollment,
			unlocking,
			setUnlocking,
			resume,
			announcement,
			pendingFileName,
		}),
		[
			announcement,
			blocked,
			cancelEnrollment,
			enrolling,
			error,
			focusBlocked,
			reportUploadFailure,
			resume,
			rotate,
			rotationBusy,
			rotationPlan,
			pendingFileName,
			runWithFiles,
			runWithKey,
			unlocking,
			zero.userID,
		],
	);
}

export function AttachmentGateChrome({
	gate,
	workspaceName,
}: {
	gate: AttachmentGateController;
	workspaceName: string;
}) {
	const [confirmRotation, setConfirmRotation] = useState(false);
	const blockedRef = useRef<HTMLDivElement>(null);
	const { consumeBlockedFocus, focusBlocked } = gate;
	useEffect(() => {
		if (!focusBlocked) return;
		blockedRef.current?.focus();
		consumeBlockedFocus();
	}, [consumeBlockedFocus, focusBlocked]);
	const rotators =
		gate.rotationPlan?.members.filter(
			(member) =>
				ADMIN_ROLES.has(member.role) && member.recipientPublicKey !== null,
		) ?? [];
	const names = displayNames(rotators.map((member) => member.name));

	return (
		<>
			{gate.blocked && (
				<section
					ref={blockedRef}
					tabIndex={-1}
					aria-label={m.e2e_rotation_blocked_title()}
					data-testid="attachment-rotation-blocked"
					className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<div className="flex items-start gap-2">
						<ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
						<div className="flex min-w-0 flex-col gap-1">
							<p className="font-medium">{m.e2e_rotation_blocked_title()}</p>
							<p className="text-sm text-muted-foreground">
								{m.e2e_rotation_blocked_body({ workspace: workspaceName })}
							</p>
							<p className="text-sm text-muted-foreground">
								{m.e2e_rotation_blocked_unaffected()}
							</p>
							{names && (
								<p className="text-sm text-muted-foreground">
									{m.e2e_rotation_blocked_who({ names })}
								</p>
							)}
						</div>
					</div>
					{gate.rotationPlan?.canRotate && (
						<Button
							type="button"
							variant="outline"
							className="w-full sm:self-start sm:w-auto"
							onClick={() => setConfirmRotation(true)}
						>
							<KeyRound /> {m.e2e_rotation_action()}
						</Button>
					)}
				</section>
			)}

			{gate.error && (
				<p role="alert" className="text-sm text-destructive">
					{gate.error}
				</p>
			)}
			<span role="status" className="sr-only">
				{gate.announcement}
			</span>

			<EnrollmentWizard
				open={gate.enrolling}
				onOpenChange={gate.setEnrolling}
				userId={gate.userId}
				pendingFileName={gate.pendingFileName}
				onEnrolled={() => void gate.resume()}
				onCancelled={gate.cancelEnrollment}
			/>
			<UnlockDialog
				open={gate.unlocking}
				onOpenChange={gate.setUnlocking}
				userId={gate.userId}
				onUnlocked={() => void gate.resume()}
			/>

			<Dialog open={confirmRotation} onOpenChange={setConfirmRotation}>
				<DialogContent data-testid="attachment-rotation-dialog">
					<DialogHeader>
						<DialogTitle>
							{m.e2e_rotation_confirm_title({ workspace: workspaceName })}
						</DialogTitle>
						<DialogDescription>
							{m.e2e_rotation_confirm_body()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setConfirmRotation(false)}
						>
							{m.confirm_cancel()}
						</Button>
						<Button
							type="button"
							disabled={gate.rotationBusy}
							onClick={() => {
								void gate.rotate().then((ok) => {
									if (ok) setConfirmRotation(false);
								});
							}}
						>
							{gate.rotationBusy && <LoaderCircle className="animate-spin" />}
							{gate.rotationBusy
								? m.e2e_rotation_working()
								: m.e2e_rotation_confirm_submit()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function grantForAttachment(
	grants: MyAttachmentGrant[],
	workspaceId: string,
	keyVersion: number,
): MyAttachmentGrant | null {
	return (
		grants.find(
			(grant) =>
				grant.workspaceId === workspaceId && grant.keyVersion === keyVersion,
		) ?? null
	);
}

export function grantHolderNames(grant: MyAttachmentGrant | null): string {
	return grant ? displayNames(grant.holders.map((holder) => holder.name)) : "";
}
