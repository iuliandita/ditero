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
	fetchMyGrants,
	type MyAttachmentGrant,
} from "../../lib/e2e/attachment-api.ts";
import {
	useKeyring,
	type WorkspaceKeyMaterial,
} from "../../lib/e2e/KeyringProvider.tsx";
import { startKeyPoll } from "../../lib/e2e/key-poll.ts";
import {
	AttachmentUploadCapabilityError,
	AttachmentUploadError,
} from "../../lib/e2e/upload.ts";
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
	// Where the selection was made; a wait never completes anywhere else.
	workspaceId: string;
	scope: string;
};

export type AttachmentGateController = {
	blocked: boolean;
	error: string | null;
	clearError: () => void;
	runWithFiles: (files: File[], action: ReadyAction) => Promise<boolean>;
	hasPendingAction: () => boolean;
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

// A selection waiting on a grant keeps its files and retries until the key
// arrives, for at most ten minutes; picking again starts a fresh wait. Moving
// to another workspace or parent (the scope) abandons it.
const KEY_WAIT_MS = 10_000;
const KEY_WAIT_RUNS = 60;

function displayNames(names: string[]): string {
	if (names.length <= 3) return formatList(names);
	return `${formatList(names.slice(0, 3), "unit")} ${m.e2e_grant_who_overflow({ count: names.length - 3 })}`;
}

export function useAttachmentGate(
	workspaceId: string,
	scope = "",
): AttachmentGateController {
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const keyring = useKeyring();
	const runtimeFetcher = keyring.runtime.fetcher;
	const attachmentFetcher = keyring.runtime.attachments?.fetcher;
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
	// Zero is idle; every failed selection gets a new generation.
	const [keyWait, setKeyWait] = useState(0);
	const keyWaits = useRef(0);
	const alive = useRef(true);
	const context = useRef({ workspaceId, scope });
	context.current = { workspaceId, scope };
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
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
		void fetchWorkspaceRotationPlan(workspaceId, runtimeFetcher)
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
	}, [blocked, runtimeFetcher, workspaceId]);

	const abandon = useCallback((current: PendingAction, message: string) => {
		if (pending.current !== current) return;
		pending.current = null;
		setKeyWait(0);
		setPendingFileName(null);
		setError(message);
	}, []);

	useEffect(() => {
		const current = pending.current;
		if (
			current &&
			(current.workspaceId !== workspaceId || current.scope !== scope)
		)
			abandon(current, m.attachment_key_wait_moved());
	}, [abandon, scope, workspaceId]);

	const continueWithKey = useCallback(
		async (current: PendingAction, waiting = false): Promise<boolean> => {
			// workspaceKey reconciles first, so one call is a full retry.
			let key = await keyring.workspaceKey(
				current.workspaceId,
				current.keyVersion,
			);
			if (!key && !waiting) {
				await keyring.refreshWorkspaceKeys();
				key = await keyring.workspaceKey(
					current.workspaceId,
					current.keyVersion,
				);
			}
			// A newer selection or an unmount superseded this one meanwhile.
			if (!alive.current || pending.current !== current) return false;
			if (
				current.workspaceId !== context.current.workspaceId ||
				current.scope !== context.current.scope
			) {
				abandon(current, m.attachment_key_wait_moved());
				return false;
			}
			if (key && key.workspaceId !== current.workspaceId) {
				console.error("attachments: key belongs to another workspace");
				abandon(current, m.attachment_error_upload_failed());
				return false;
			}
			if (!key) {
				setError(m.attachment_key_pending());
				if (!waiting) {
					keyWaits.current += 1;
					setKeyWait(keyWaits.current);
				}
				return false;
			}
			pending.current = null;
			setKeyWait(0);
			if (waiting) setError(null);
			await current.action(key, current.files);
			return true;
		},
		[abandon, keyring],
	);
	const continueRef = useRef(continueWithKey);
	continueRef.current = continueWithKey;

	useEffect(() => {
		if (keyWait === 0 || keyring.state !== "ready") return;
		const poll = startKeyPoll({
			intervalMs: KEY_WAIT_MS,
			maxRuns: KEY_WAIT_RUNS,
			run: async () => {
				const current = pending.current;
				if (!current) return true;
				// An open request means no granter has answered; skip the full
				// reconcile until one has.
				const requests = await fetchMyGrants(runtimeFetcher);
				if (pending.current !== current) return true;
				const asked = requests.some(
					(request) =>
						request.workspaceId === current.workspaceId &&
						request.state === "pending" &&
						(current.keyVersion === undefined ||
							request.keyVersion === current.keyVersion),
				);
				if (asked) return false;
				return await continueRef.current(current, true);
			},
			onExhausted: () => {
				const current = pending.current;
				if (current) abandon(current, m.attachment_key_wait_expired());
			},
			onError: (caught) =>
				console.error("attachments: waiting for file access failed", caught),
		});
		return () => poll.stop();
	}, [abandon, keyWait, keyring.state, runtimeFetcher]);

	const begin = useCallback(
		async (
			selection: Omit<PendingAction, "workspaceId" | "scope">,
		): Promise<boolean> => {
			const current = { ...selection, ...context.current };
			setError(null);
			setKeyWait(0);
			pending.current = current;
			setPendingFileName(current.files[0]?.name ?? null);
			// Historical reads retain their key version; only new files need rotation.
			if (blocked && current.keyVersion === undefined) {
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
				limit = (await fetchAttachmentConfig(attachmentFetcher)).maxFileBytes;
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
		[attachmentFetcher, begin],
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
		if (caught instanceof AttachmentUploadCapabilityError) {
			setError(
				caught.reason === "bounded-ciphertext-limit"
					? m.attachment_error_browser_ciphertext_limit({
							limit: formatBytes(caught.limitBytes),
						})
					: m.attachment_error_browser_unavailable(),
			);
			return;
		}
		if (caught instanceof AttachmentUploadError && caught.status === 413) {
			setError(m.attachment_error_server_limit());
			return;
		}
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
		setKeyWait(0);
		setPendingFileName(null);
		setError(m.e2e_enroll_discard_notice());
	}, []);

	const rotate = useCallback(async () => {
		if (rotationBusy) return false;
		setRotationBusy(true);
		setError(null);
		try {
			const result = await rotateWorkspaceKey(workspaceId, runtimeFetcher);
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
	}, [keyring, resume, rotationBusy, runtimeFetcher, workspaceId]);

	return useMemo(
		() => ({
			blocked,
			error,
			clearError: () => setError(null),
			runWithFiles,
			hasPendingAction: () => pending.current !== null,
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
	onRotationOpen,
	onRotationClose,
}: {
	gate: AttachmentGateController;
	workspaceName: string;
	onRotationOpen?: (dialog: HTMLElement) => void;
	onRotationClose?: (dialog: HTMLElement) => boolean;
}) {
	const rotationDialog = useRef<HTMLDivElement>(null);
	const openedRotationDialog = useRef<HTMLElement | null>(null);
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
					className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<div className="flex items-start gap-2">
						<ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
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
				<DialogContent
					ref={rotationDialog}
					data-testid="attachment-rotation-dialog"
					onOpenAutoFocus={() => {
						if (rotationDialog.current) {
							openedRotationDialog.current = rotationDialog.current;
							onRotationOpen?.(rotationDialog.current);
						}
					}}
					onCloseAutoFocus={(event) => {
						const dialog = openedRotationDialog.current;
						openedRotationDialog.current = null;
						if (dialog && onRotationClose?.(dialog)) event.preventDefault();
					}}
				>
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
