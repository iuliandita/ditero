import { useQuery, useZero } from "@rocicorp/zero/react";
import { useEffect, useRef, useState } from "react";
import { randomId } from "../../../domain/random-id.ts";
import {
	WORKSPACE_NAME_MAX_LENGTH,
	workspaceNameSchema,
} from "../../../domain/workspace-create.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { mutationServerSucceeded } from "../../lib/pref-mutation.ts";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";

export function CreateWorkspaceDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (id: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const keyring = useKeyring();
	const [workspaces, workspaceDetails] = useQuery(queries.workspaces.mine());
	const [memberships, membershipDetails] = useQuery(queries.memberships.mine());
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [persisted, setPersisted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const attempt = useRef<{
		id: string;
		membershipId: string;
		name: string;
		userId: string;
	} | null>(null);
	const busy = useRef(false);
	const completed = useRef(false);
	const mounted = useRef(true);
	const actor = useRef(zero.userID);
	actor.current = zero.userID;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		const created = attempt.current;
		if (
			completed.current ||
			!persisted ||
			!created ||
			actor.current !== created.userId ||
			!mounted.current
		)
			return;
		if (
			workspaceDetails.type !== "complete" ||
			membershipDetails.type !== "complete"
		)
			return;
		const workspace = workspaces.find((row) => row.id === created.id);
		const seats = memberships.filter(
			(row) => row.workspaceId === created.id && row.userId === created.userId,
		);
		if (
			workspace?.ownerId !== created.userId ||
			workspace.kind !== "shared" ||
			workspace.name !== created.name ||
			seats.length !== 1 ||
			seats[0]?.id !== created.membershipId ||
			seats[0].role !== "owner"
		)
			return;
		// Creation commits independently of enrollment; existing provisioning owns workspace keys.
		completed.current = true;
		void keyring.refreshWorkspaceKeys();
		onCreated(created.id);
	}, [
		persisted,
		workspaceDetails.type,
		membershipDetails.type,
		workspaces,
		memberships,
		keyring,
		onCreated,
	]);

	async function submit() {
		if (busy.current || persisted) return;
		if (!zero.userID) return;
		const parsed = workspaceNameSchema.safeParse(name);
		if (!parsed.success) {
			setError(m.workspace_create_invalid_name());
			return;
		}
		const current = attempt.current ?? {
			id: randomId(),
			membershipId: randomId(),
			name: parsed.data,
			userId: zero.userID,
		};
		if (current.userId !== zero.userID) return;
		attempt.current = current;
		busy.current = true;
		setPending(true);
		setError(null);
		try {
			const mutation = zero.mutate(
				mutators.workspace.create({
					id: current.id,
					membershipId: current.membershipId,
					name: current.name,
				}),
			);
			// Attach the authoritative observer immediately, including while offline acceptance waits.
			const saved = mutationServerSucceeded(mutation);
			if ((await mutation.client).type !== "success" || !(await saved))
				throw new Error("Workspace creation failed");
			if (mounted.current && actor.current === current.userId)
				setPersisted(true);
		} catch {
			if (mounted.current && actor.current === current.userId)
				setError(m.workspace_create_failed());
		} finally {
			busy.current = false;
			if (mounted.current && actor.current === current.userId)
				setPending(false);
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending && !persisted) onClose();
			}}
		>
			<DialogContent
				className="sm:max-w-sm"
				data-testid="create-workspace-dialog"
			>
				<DialogHeader>
					<DialogTitle>{m.workspace_create_title()}</DialogTitle>
					<DialogDescription>
						{m.workspace_create_description()}
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label htmlFor="new-workspace-name" className="text-sm font-medium">
						{m.workspace_create_name()}
					</label>
					<Input
						className="pointer-coarse:min-h-11"
						id="new-workspace-name"
						data-testid="create-workspace-name"
						autoFocus
						maxLength={WORKSPACE_NAME_MAX_LENGTH}
						value={name}
						disabled={pending || persisted || attempt.current !== null}
						onChange={(event) => {
							setName(event.target.value);
							setError(null);
						}}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "create-workspace-error" : undefined}
					/>
					{error && (
						<p
							id="create-workspace-error"
							data-testid="create-workspace-error"
							role="alert"
							className="mt-2 text-sm text-destructive"
						>
							{error}
						</p>
					)}
					{(pending || persisted) && (
						<p role="status" className="mt-2 text-sm text-muted-foreground">
							{m.workspace_create_pending()}
						</p>
					)}
					<DialogFooter className="mt-4">
						<Button
							type="submit"
							className="pointer-coarse:min-h-11"
							data-testid="create-workspace-submit"
							disabled={pending || persisted || !name.trim()}
						>
							{error && attempt.current
								? m.workspace_create_retry()
								: m.workspace_create_action()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
