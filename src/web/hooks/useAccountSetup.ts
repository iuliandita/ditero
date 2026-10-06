import { useConnectionState, useQuery, useZero } from "@rocicorp/zero/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	ACCOUNT_SETUP_CATALOG_VERSION,
	type AccountSetupRequest,
	type AccountSetupState,
	accountSetupRequestSchema,
	accountSetupRequestSignature,
} from "../../domain/account-setup.ts";
import { accountSetupStoredStateSchema } from "../../domain/account-setup-storage.ts";
import type { Locale } from "../../domain/locale.ts";
import { randomId } from "../../domain/random-id.ts";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { useAccountStorageScope } from "../lib/native-account.tsx";
import { mutationResultFailure } from "../lib/run-mutation.ts";
import { isZeroClientOwnerActive } from "../lib/zero-lifecycle.ts";

export type AccountSetupControllerState =
	| "ready"
	| "loading"
	| "submitting"
	| "uncertain"
	| "conflict"
	| "completed";
export type AccountSetupControllerError =
	| "managed"
	| "offline"
	| "loading"
	| "invalid-state"
	| "invalid-request"
	| "request-conflict"
	| "revision-conflict"
	| "already-completed"
	| "apply-required"
	| "rejected"
	| "uncertain";
type Attempt = {
	request: AccountSetupRequest;
	state: AccountSetupControllerState;
	error?: AccountSetupControllerError;
	serverSucceeded: boolean;
	receiptConfirmed: boolean;
};
function subscribeOnline(changed: () => void) {
	window.addEventListener("online", changed);
	window.addEventListener("offline", changed);
	return () => {
		window.removeEventListener("online", changed);
		window.removeEventListener("offline", changed);
	};
}
function refusal(message: string): AccountSetupControllerError {
	for (const code of [
		"request-conflict",
		"revision-conflict",
		"already-completed",
		"apply-required",
	] as const)
		if (message.includes(code)) return code;
	return message.includes("managed account") ? "managed" : "rejected";
}
function receiptMatches(
	state: AccountSetupState,
	request: AccountSetupRequest,
) {
	const receipt = state.receipt;
	return (
		receipt !== null &&
		receipt.request.requestId === request.requestId &&
		accountSetupRequestSignature(receipt.request) ===
			accountSetupRequestSignature(request) &&
		receipt.revision === request.expectedRevision + 1 &&
		state.revision === receipt.revision &&
		state.outcome === receipt.outcome
	);
}

// Keep this controller mounted in the account shell, above the Settings surface.
export function useAccountSetup({
	currentLocale,
	profileEmail,
}: {
	currentLocale: Locale;
	profileEmail?: string;
}) {
	const zero = useZero<typeof schema>();
	const storageScope = useAccountStorageScope();
	const connection = useConnectionState();
	const browserOnline = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => false,
	);
	const [rows, setupDetails] = useQuery(queries.accountSetup.mine());
	const [managedRows, managedDetails] = useQuery(
		queries.managedAccounts.mine(),
	);
	const [, refresh] = useState(0);
	const alive = useRef(true);
	const owner = useRef<{
		zero: typeof zero;
		userID: string | undefined;
		storageScope: string;
		requestId: string;
		attempt: Attempt | null;
		busy: boolean;
		generation: number;
		error?: AccountSetupControllerError;
	} | null>(null);
	if (
		!owner.current ||
		owner.current.zero !== zero ||
		owner.current.userID !== zero.userID ||
		owner.current.storageScope !== storageScope
	)
		owner.current = {
			zero,
			userID: zero.userID,
			storageScope,
			requestId: randomId(),
			attempt: null,
			busy: false,
			generation: 0,
		};
	const captured = owner.current;
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			if (owner.current) owner.current.generation += 1;
		};
	}, []);
	const managed =
		managedRows.some((row) => row.userId === zero.userID) ||
		profileEmail?.trim().toLowerCase().split("@").at(-1) === "managed.invalid";
	const authoritative =
		setupDetails.type === "complete" && managedDetails.type === "complete";
	const row = rows.find((candidate) => candidate.id === zero.userID);
	const parsed = accountSetupStoredStateSchema.safeParse(
		row
			? {
					state: {
						outcome: row.outcome,
						revision: row.revision,
						receipt: row.latestReceipt ?? null,
					},
					catalogVersion: row.catalogVersion ?? null,
					locale: row.locale ?? null,
					generatedIds: row.generatedIds ?? null,
				}
			: {
					state: { outcome: "pending", revision: 0, receipt: null },
					catalogVersion: null,
					locale: null,
					generatedIds: null,
				},
	);
	const synced = parsed.success ? parsed.data.state : null;
	const online = browserOnline && connection.name === "connected";
	const latest = useRef({
		authoritative,
		synced,
		managed,
		online,
		currentLocale,
	});
	latest.current = { authoritative, synced, managed, online, currentLocale };
	function active() {
		return (
			alive.current &&
			owner.current === captured &&
			captured.userID === zero.userID &&
			isZeroClientOwnerActive(captured.zero)
		);
	}
	function update() {
		if (active()) refresh((value) => value + 1);
	}
	function blocked(): AccountSetupControllerError | undefined {
		if (!active() || !captured.userID) return "loading";
		if (latest.current.managed) return "managed";
		if (
			!navigator.onLine ||
			captured.zero.connection.state.current.name !== "connected"
		)
			return "offline";
		if (!latest.current.authoritative) return "loading";
		if (!latest.current.synced) return "invalid-state";
	}
	function reconcile() {
		const attempt = captured.attempt;
		const current = latest.current;
		if (
			!active() ||
			!attempt ||
			!current.authoritative ||
			!current.synced ||
			current.managed ||
			!current.online
		)
			return;
		if (receiptMatches(current.synced, attempt.request)) {
			if (attempt.serverSucceeded || attempt.receiptConfirmed) {
				attempt.state = "completed";
				attempt.error = undefined;
			}
		} else if (
			current.synced.revision > attempt.request.expectedRevision ||
			current.synced.outcome === "completed"
		) {
			attempt.state = "conflict";
			attempt.error =
				current.synced.outcome === "completed"
					? "already-completed"
					: "revision-conflict";
		}
	}
	reconcile();
	async function dispatch() {
		const attempt = captured.attempt;
		if (!attempt || captured.busy) return;
		const reason = blocked();
		if (reason) {
			attempt.error = reason;
			update();
			return;
		}
		reconcile();
		if (attempt.state === "completed" || attempt.state === "conflict") {
			update();
			return;
		}
		const generation = captured.generation;
		captured.busy = true;
		attempt.state = "submitting";
		attempt.error = undefined;
		update();
		try {
			const mutation = captured.zero.mutate(
				mutators.accountSetup.apply(attempt.request),
			);
			const clientFailure = mutationResultFailure(await mutation.client);
			if (!active() || captured.generation !== generation) return;
			if (clientFailure) {
				attempt.state = clientFailure.kind === "app" ? "conflict" : "uncertain";
				attempt.error =
					clientFailure.kind === "app"
						? refusal(clientFailure.message)
						: "uncertain";
				return;
			}
			const serverFailure = mutationResultFailure(await mutation.server);
			if (!active() || captured.generation !== generation) return;
			if (serverFailure) {
				attempt.state = serverFailure.kind === "app" ? "conflict" : "uncertain";
				attempt.error =
					serverFailure.kind === "app"
						? refusal(serverFailure.message)
						: "uncertain";
			} else {
				attempt.serverSucceeded = true;
				attempt.state = "uncertain";
				attempt.error = "uncertain";
				reconcile();
			}
		} catch {
			if (!active() || captured.generation !== generation) return;
			attempt.state = "uncertain";
			attempt.error = "uncertain";
		} finally {
			if (active() && captured.generation === generation) {
				captured.busy = false;
				update();
			}
		}
	}
	async function submit(input: AccountSetupRequest) {
		if (captured.attempt || captured.busy) return;
		const reason = blocked();
		if (reason) {
			captured.error = reason;
			update();
			return;
		}
		const request = accountSetupRequestSchema.safeParse(input);
		if (
			!request.success ||
			request.data.requestId !== captured.requestId ||
			request.data.locale !== latest.current.currentLocale ||
			request.data.catalogVersion !== ACCOUNT_SETUP_CATALOG_VERSION ||
			request.data.expectedRevision !== latest.current.synced?.revision
		) {
			captured.error = "invalid-request";
			update();
			return;
		}
		if (latest.current.synced?.outcome === "completed") {
			captured.error = "already-completed";
			update();
			return;
		}
		if (
			(latest.current.synced?.outcome === "custom" ||
				latest.current.synced?.outcome === "skipped") &&
			request.data.mode !== "basic" &&
			request.data.mode !== "guided"
		) {
			captured.error = "apply-required";
			update();
			return;
		}
		captured.error = undefined;
		captured.attempt = {
			request: request.data,
			state: "uncertain",
			serverSucceeded: false,
			receiptConfirmed: false,
		};
		await dispatch();
	}
	async function retry() {
		await dispatch();
	}
	async function resume() {
		const current = latest.current;
		const attempt = captured.attempt;
		// Authenticated synced receipt identity proves commit after a lost response.
		// Resume only checks that evidence; Retry is the explicit replay write.
		if (
			active() &&
			attempt &&
			current.authoritative &&
			current.online &&
			!current.managed &&
			current.synced &&
			receiptMatches(current.synced, attempt.request)
		)
			attempt.receiptConfirmed = true;
		reconcile();
		update();
	}
	function fresh() {
		if (captured.busy || blocked()) return;
		const current = latest.current.synced;
		if (
			!current ||
			(current.outcome !== "custom" && current.outcome !== "skipped")
		)
			return;
		if (
			captured.attempt &&
			current.revision <= captured.attempt.request.expectedRevision
		)
			return;
		captured.error = undefined;
		captured.attempt = null;
		captured.requestId = randomId();
		update();
	}
	const attempt = captured.attempt;
	const error: AccountSetupControllerError | undefined = managed
		? "managed"
		: !parsed.success
			? "invalid-state"
			: (attempt?.error ?? captured.error ?? (!online ? "offline" : undefined));
	const state: AccountSetupControllerState = managed
		? "conflict"
		: !authoritative || !parsed.success
			? "loading"
			: (attempt?.state ??
				(synced?.outcome === "completed"
					? "completed"
					: !online
						? "loading"
						: "ready"));
	return {
		state,
		error,
		managed,
		authoritative,
		online,
		outcome: synced?.outcome,
		revision: synced?.revision ?? 0,
		expectedRevision:
			attempt?.request.expectedRevision ?? synced?.revision ?? 0,
		requestId: attempt?.request.requestId ?? captured.requestId,
		locale: attempt?.request.locale ?? currentLocale,
		allowEmptyChoice:
			synced?.outcome !== "custom" && synced?.outcome !== "skipped",
		request: attempt?.request ?? null,
		submit,
		retry,
		resume,
		fresh,
	};
}
