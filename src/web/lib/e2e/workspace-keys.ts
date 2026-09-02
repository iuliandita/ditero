import { z } from "zod";
import { KEY_BYTES } from "../../../domain/e2e/envelope.ts";
import {
	importRecipientPrivateKey,
	importRecipientPublicKey,
	openWdk,
	publicKeyFingerprint,
	sealWdk,
} from "../../../domain/e2e/hpke.ts";
import {
	commitWdk,
	verifyWdkCommitment,
	WdkCommitmentError,
} from "../../../domain/e2e/wdk-commitment.ts";
import { decodeBytes, encodeBytes } from "../../../domain/e2e/wire.ts";

const ownWorkspaceKeySchema = z.object({
	membershipKeyId: z.string(),
	workspaceId: z.string(),
	keyVersion: z.number().int().positive(),
	enc: z.string(),
	ciphertext: z.string(),
	recipientPublicKey: z.string(),
	commitment: z.string(),
	active: z.boolean(),
	requestId: z.string().nullable(),
});

const responseSchema = z.object({
	keys: z.array(ownWorkspaceKeySchema),
});

export type OwnWorkspaceKey = z.infer<typeof ownWorkspaceKeySchema>;
export type WorkspaceKeyFailure = {
	workspaceId: string;
	keyVersion: number;
};

type WorkspaceKeyring = {
	privateKey: () => Uint8Array;
	putWdk: (workspaceId: string, version: number, wdk: Uint8Array) => void;
};

type ReconcileKeyring = WorkspaceKeyring & {
	wdkFor: (workspaceId: string, version: number) => Uint8Array | undefined;
};

export type E2eFetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const defaultFetcher: E2eFetcher = (input, init) => fetch(input, init);

async function reportFailedGrant(
	requestId: string | null,
	fetcher: E2eFetcher,
): Promise<void> {
	if (!requestId) return;
	await fetcher("/api/e2e/grants/fail", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId,
			reason: "recipient could not verify workspace key",
		}),
	});
}

/**
 * Opens the caller's server-held HPKE wraps and adopts only keys that match the
 * immutable workspace commitment. WDKs leave this function through putWdk,
 * whose implementation is the in-memory keyring; this module writes no
 * browser storage.
 */
export async function loadWorkspaceKeys(
	keyring: WorkspaceKeyring,
	userId: string,
	publicKey: string,
	fetcher: E2eFetcher = defaultFetcher,
): Promise<{ loaded: OwnWorkspaceKey[]; failed: WorkspaceKeyFailure[] }> {
	const response = await fetcher("/api/e2e/keys/mine", {
		credentials: "include",
	});
	if (!response.ok) {
		throw new Error(`workspace-keys: fetch failed (${response.status})`);
	}
	const { keys } = responseSchema.parse(await response.json());
	const publicKeyBytes = decodeBytes(publicKey);
	const recipientKey = await importRecipientPrivateKey(keyring.privateKey());
	const recipientFingerprint = await publicKeyFingerprint(publicKeyBytes);
	const loaded: OwnWorkspaceKey[] = [];
	const failed: WorkspaceKeyFailure[] = [];

	for (const row of keys) {
		let wdk: Uint8Array;
		try {
			if (row.recipientPublicKey !== publicKey) {
				throw new Error("workspace-keys: wrap targets a stale identity");
			}
			wdk = await openWdk(
				{
					enc: decodeBytes(row.enc),
					ciphertext: decodeBytes(row.ciphertext),
				},
				recipientKey,
				{
					workspaceId: row.workspaceId,
					keyVersion: row.keyVersion,
					recipientUserId: userId,
					recipientFingerprint,
				},
			);
			await verifyWdkCommitment(
				wdk,
				row.workspaceId,
				row.keyVersion,
				row.commitment,
			);
		} catch (error) {
			failed.push({
				workspaceId: row.workspaceId,
				keyVersion: row.keyVersion,
			});
			// A newer format means this client needs an upgrade; the durable grant
			// may be perfectly valid. Marking it failed would tell every granter to
			// replace good data with something this client still cannot understand.
			if (
				!(
					error instanceof WdkCommitmentError &&
					error.reason === "unsupported-version"
				)
			) {
				await reportFailedGrant(row.requestId, fetcher).catch(() => undefined);
			}
			continue;
		}
		// A max-age lock can land while the crypto above runs. That is a local
		// state transition, not evidence that the durable grant is corrupt, so it
		// stays outside the catch that reports a failed request.
		keyring.putWdk(row.workspaceId, row.keyVersion, wdk);
		loaded.push(row);
	}
	return { loaded, failed };
}

const pendingProvisionsSchema = z.object({
	workspaces: z.array(
		z.object({
			id: z.string(),
			version: z.number().int().positive(),
			reason: z.enum(["no-key", "no-grant"]),
			commitment: z.string().nullable(),
		}),
	),
});

const provisionResultSchema = z.object({
	workspaceId: z.string(),
	version: z.number().int().positive(),
	outcome: z.enum(["minted", "already", "repaired", "exists"]),
});

const pendingGrantsSchema = z.object({
	requests: z.array(
		z.object({
			requestId: z.string(),
			workspaceId: z.string(),
			keyVersion: z.number().int().positive(),
			recipientUserId: z.string(),
			recipientPublicKey: z.string().nullable(),
		}),
	),
});

const rotationMemberSchema = z.object({
	membershipId: z.string(),
	userId: z.string(),
	name: z.string(),
	role: z.enum(["owner", "admin", "member", "viewer"]),
	recipientPublicKey: z.string().nullable(),
});

const rotationPlanSchema = z.object({
	workspaceId: z.string(),
	currentVersion: z.number().int().positive().nullable(),
	currentCommitment: z.string().nullable(),
	rotationRequired: z.boolean(),
	canRotate: z.boolean(),
	members: z.array(rotationMemberSchema),
});

const rotationResultSchema = z.object({
	workspaceId: z.string(),
	version: z.number().int().positive(),
	commitment: z.string(),
	outcome: z.enum(["rotated", "already"]),
});

export type WorkspaceRotationPlan = z.infer<typeof rotationPlanSchema>;

export async function fetchWorkspaceRotationPlan(
	workspaceId: string,
	fetcher: E2eFetcher = defaultFetcher,
): Promise<WorkspaceRotationPlan> {
	return await jsonRequest(
		fetcher,
		`/api/e2e/members/${encodeURIComponent(workspaceId)}/keys`,
		rotationPlanSchema,
	);
}

export async function rotateWorkspaceKey(
	workspaceId: string,
	fetcher: E2eFetcher = defaultFetcher,
): Promise<{
	workspaceId: string;
	version: number;
	commitment: string;
	outcome: "rotated" | "already";
	wdk: Uint8Array | null;
}> {
	const plan = await fetchWorkspaceRotationPlan(workspaceId, fetcher);
	if (!plan.rotationRequired) {
		throw new Error("workspace-keys: rotation is not required");
	}
	if (!plan.canRotate) {
		throw new Error("workspace-keys: rotation is not permitted");
	}
	if (plan.currentVersion === null || plan.currentCommitment === null) {
		throw new Error("workspace-keys: active workspace key is missing");
	}
	const nextVersion = plan.currentVersion + 1;
	const wdk = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	const commitment = await commitWdk(wdk, workspaceId, nextVersion);
	const grants = await Promise.all(
		plan.members
			.filter(
				(member): member is typeof member & { recipientPublicKey: string } =>
					member.recipientPublicKey !== null,
			)
			.map(async (member) => ({
				membershipId: member.membershipId,
				userId: member.userId,
				recipientPublicKey: member.recipientPublicKey,
				...(await sealedFor(
					wdk,
					member.recipientPublicKey,
					workspaceId,
					nextVersion,
					member.userId,
				)),
			})),
	);
	const result = await jsonRequest(
		fetcher,
		`/api/e2e/workspaces/${encodeURIComponent(workspaceId)}/rotate`,
		rotationResultSchema,
		jsonPost({
			previousVersion: plan.currentVersion,
			commitment,
			grants,
		}),
	);
	if (result.workspaceId !== workspaceId || result.version !== nextVersion) {
		throw new Error(
			"workspace-keys: rotation returned a different workspace version",
		);
	}
	if (result.outcome === "already") return { ...result, wdk: null };
	if (result.commitment !== commitment) {
		throw new Error("workspace-keys: rotation returned a different commitment");
	}
	return { ...result, wdk };
}

async function jsonRequest<T>(
	fetcher: E2eFetcher,
	path: string,
	schema: z.ZodType<T>,
	init?: RequestInit,
): Promise<T> {
	const response = await fetcher(path, {
		credentials: "include",
		...init,
	});
	if (!response.ok) {
		throw new Error(`workspace-keys: ${path} failed (${response.status})`);
	}
	return schema.parse(await response.json());
}

const jsonPost = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

async function sealedFor(
	wdk: Uint8Array,
	publicKey: string,
	workspaceId: string,
	keyVersion: number,
	recipientUserId: string,
) {
	const bytes = decodeBytes(publicKey);
	const sealed = await sealWdk(wdk, await importRecipientPublicKey(bytes), {
		workspaceId,
		keyVersion,
		recipientUserId,
		recipientFingerprint: await publicKeyFingerprint(bytes),
	});
	return {
		enc: encodeBytes(sealed.enc),
		ciphertext: encodeBytes(sealed.ciphertext),
	};
}

/**
 * Completes the client-owned key lifecycle after unlock: load existing wraps,
 * mint only workspaces where the server proves no key exists, request an
 * existing key when this member lacks it, and fulfil requests for versions the
 * caller can open.
 */
export async function reconcileWorkspaceKeys(
	keyring: ReconcileKeyring,
	userId: string,
	publicKey: string,
	fetcher: E2eFetcher = defaultFetcher,
): Promise<OwnWorkspaceKey[]> {
	const loaded = await loadWorkspaceKeys(keyring, userId, publicKey, fetcher);
	const rows = [...loaded.loaded];
	const pending = await jsonRequest(
		fetcher,
		"/api/e2e/provision/pending",
		pendingProvisionsSchema,
	);

	for (const workspace of pending.workspaces) {
		if (workspace.reason === "no-grant") {
			await jsonRequest(
				fetcher,
				"/api/e2e/grants/request",
				z.object({
					requestId: z.string(),
					keyVersion: z.number(),
					state: z.enum(["pending", "ready"]),
				}),
				jsonPost({ workspaceId: workspace.id }),
			);
			continue;
		}

		const wdk = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const commitment = await commitWdk(wdk, workspace.id, workspace.version);
		const sealed = await sealedFor(
			wdk,
			publicKey,
			workspace.id,
			workspace.version,
			userId,
		);
		const provisioned = await jsonRequest(
			fetcher,
			"/api/e2e/provision",
			provisionResultSchema,
			jsonPost({
				workspaceId: workspace.id,
				commitment,
				...sealed,
			}),
		);
		if (provisioned.outcome === "exists") {
			await jsonRequest(
				fetcher,
				"/api/e2e/grants/request",
				z.object({
					requestId: z.string(),
					keyVersion: z.number(),
					state: z.enum(["pending", "ready"]),
				}),
				jsonPost({ workspaceId: workspace.id }),
			);
			continue;
		}
		keyring.putWdk(workspace.id, workspace.version, wdk);
		rows.push({
			membershipKeyId: `local:${workspace.id}:${workspace.version}`,
			workspaceId: workspace.id,
			keyVersion: workspace.version,
			...sealed,
			recipientPublicKey: publicKey,
			commitment,
			active: true,
			requestId: null,
		});
	}

	const grants = await jsonRequest(
		fetcher,
		"/api/e2e/grants/pending",
		pendingGrantsSchema,
	);
	for (const request of grants.requests) {
		if (!request.recipientPublicKey) continue;
		const wdk = keyring.wdkFor(request.workspaceId, request.keyVersion);
		if (!wdk) continue;
		const sealed = await sealedFor(
			wdk,
			request.recipientPublicKey,
			request.workspaceId,
			request.keyVersion,
			request.recipientUserId,
		);
		await jsonRequest(
			fetcher,
			"/api/e2e/grants",
			z.object({
				requestId: z.string(),
				outcome: z.enum(["granted", "already"]),
			}),
			jsonPost({
				requestId: request.requestId,
				recipientPublicKey: request.recipientPublicKey,
				...sealed,
			}),
		);
	}
	return rows;
}
