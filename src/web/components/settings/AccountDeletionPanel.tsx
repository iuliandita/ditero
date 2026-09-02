import { useRef, useState } from "react";
import { z } from "zod";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { clearDeviceKey } from "../../lib/e2e/device-store.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { formatList } from "../../lib/intl-format.ts";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";

const previewSchema = z.object({
	lastHolderWorkspaces: z.array(z.object({ id: z.string(), name: z.string() })),
	soleOwnerWorkspaces: z.array(z.object({ id: z.string(), name: z.string() })),
});

type DeletionPreview = z.infer<typeof previewSchema>;

export function AccountDeletionPanel() {
	const { lockNow } = useKeyring();
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<DeletionPreview | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [loading, setLoading] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const previewAbort = useRef<AbortController | null>(null);

	async function loadPreview() {
		previewAbort.current?.abort();
		const controller = new AbortController();
		previewAbort.current = controller;
		setLoading(true);
		setError(null);
		try {
			const response = await fetch("/api/account/deletion-preview", {
				credentials: "include",
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`preview failed: ${response.status}`);
			setPreview(previewSchema.parse(await response.json()));
		} catch (failure) {
			if (!controller.signal.aborted) {
				console.error(failure);
				setError(m.account_delete_failed());
			}
		} finally {
			if (!controller.signal.aborted) setLoading(false);
			if (previewAbort.current === controller) previewAbort.current = null;
		}
	}

	function showDialog() {
		setPreview(null);
		setAcknowledged(false);
		setError(null);
		setOpen(true);
		void loadPreview();
	}

	async function deleteAccount() {
		if (!preview || preview.soleOwnerWorkspaces.length > 0) return;
		if (preview.lastHolderWorkspaces.length > 0 && !acknowledged) return;
		setDeleting(true);
		setError(null);
		try {
			const response = await fetch("/api/account/delete", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ acknowledgeKeyLoss: acknowledged }),
			});
			if (response.status === 409) {
				await loadPreview();
				return;
			}
			if (!response.ok)
				throw new Error(`account delete failed: ${response.status}`);
			lockNow();
			await clearDeviceKey();
			await authClient.signOut();
			window.location.assign("/");
		} catch (failure) {
			console.error(failure);
			setError(m.account_delete_failed());
		} finally {
			setDeleting(false);
		}
	}

	const ownerNames = preview?.soleOwnerWorkspaces.map(({ name }) => name) ?? [];
	const lastHolderNames =
		preview?.lastHolderWorkspaces.map(({ name }) => name) ?? [];

	return (
		<section
			className="mt-8 border-t border-destructive/30 pt-4"
			aria-labelledby="account-delete-heading"
		>
			<h3 id="account-delete-heading" className="text-sm font-medium">
				{m.account_delete_heading()}
			</h3>
			<p className="mt-1 max-w-prose text-sm text-muted-foreground">
				{m.account_delete_description()}
			</p>
			<Button
				className="mt-3"
				variant="destructive"
				type="button"
				data-testid="delete-account-open"
				onClick={showDialog}
			>
				{m.account_delete_action()}
			</Button>

			<AlertDialog
				open={open}
				onOpenChange={(next) => {
					if (!next && !deleting) previewAbort.current?.abort();
					if (!deleting) setOpen(next);
				}}
			>
				<AlertDialogContent data-testid="delete-account-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m.account_delete_dialog_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.account_delete_dialog_body()}
						</AlertDialogDescription>
					</AlertDialogHeader>

					{loading ? (
						<p role="status" className="text-sm text-muted-foreground">
							{m.account_delete_loading()}
						</p>
					) : null}

					{ownerNames.length > 0 ? (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<p className="font-medium">{m.account_delete_owner_title()}</p>
							<p className="mt-1 text-muted-foreground">
								{m.account_delete_owner_body({
									workspace: formatList(ownerNames),
								})}
							</p>
						</div>
					) : null}

					{lastHolderNames.length > 0 ? (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<p className="font-medium">{m.e2e_last_holder_title()}</p>
							<p className="mt-1 text-muted-foreground">
								{m.e2e_last_holder_body({
									workspace: formatList(lastHolderNames),
								})}
							</p>
							<label className="mt-3 flex items-start gap-2">
								<input
									type="checkbox"
									className="mt-0.5"
									data-testid="delete-account-key-loss-ack"
									checked={acknowledged}
									onChange={(event) => setAcknowledged(event.target.checked)}
								/>
								<span>{m.e2e_last_holder_ack()}</span>
							</label>
						</div>
					) : null}

					{error ? (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					) : null}

					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>
							{m.confirm_cancel()}
						</AlertDialogCancel>
						<Button
							variant="destructive"
							type="button"
							data-testid="delete-account-confirm"
							disabled={
								loading ||
								deleting ||
								!preview ||
								ownerNames.length > 0 ||
								(lastHolderNames.length > 0 && !acknowledged)
							}
							onClick={() => void deleteAccount()}
						>
							{m.account_delete_confirm()}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
