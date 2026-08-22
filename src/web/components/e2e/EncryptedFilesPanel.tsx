import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { EnrollmentWizard } from "./EnrollmentWizard.tsx";

type Identity = { enrolled: boolean };

// Shell section 9. The second entry point into flow 1, for the user who wants
// encryption before they have a file to attach; the primary trigger is picking
// a file, which arrives with the attachment surfaces.
export function EncryptedFilesPanel() {
	const { data: session } = authClient.useSession();
	const userId = session?.user.id;
	// null while unknown, which also covers a deployment with the feature off:
	// /api/e2e/identity answers 404 there, so the panel renders nothing rather
	// than offering a setup that cannot complete.
	const [identity, setIdentity] = useState<Identity | null>(null);
	const [open, setOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/e2e/identity", {
				credentials: "include",
			});
			if (!response.ok) {
				setIdentity(null);
				return;
			}
			setIdentity((await response.json()) as Identity);
		} catch (error) {
			console.error(error);
			setIdentity(null);
		}
	}, []);

	useEffect(() => {
		if (userId) void load();
	}, [load, userId]);

	if (!identity || !userId) return null;

	return (
		<section className="mt-4" aria-labelledby="e2e-heading">
			<h3 id="e2e-heading" className="text-sm font-medium">
				{m.e2e_settings_heading()}
			</h3>

			{identity.enrolled ? (
				// Repeated verbatim from the wizard, and the only string in the
				// milestone deliberately shown twice: it is the one sentence a user
				// is most likely to want to re-read.
				<p
					data-testid="e2e-no-reset-note-settings"
					className="mt-2 text-sm font-medium"
				>
					{m.e2e_no_reset_note()}
				</p>
			) : (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
					<span data-testid="e2e-status" className="text-sm">
						{m.e2e_status_unenrolled()}
					</span>
					<Button
						type="button"
						variant="outline"
						data-testid="e2e-setup"
						onClick={() => setOpen(true)}
					>
						{m.e2e_setup_action()}
					</Button>
				</div>
			)}

			<EnrollmentWizard
				open={open}
				onOpenChange={setOpen}
				userId={userId}
				onEnrolled={() => void load()}
			/>
		</section>
	);
}
