import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { autoLockMaxAgeMs } from "../../../domain/e2e/auto-lock.ts";
import { createDeriver } from "./derive.ts";
import { deviceId } from "./device-id.ts";
import { createKeyring, type KeyringState } from "./keyring.ts";
import { createSession, type IdentityResponse } from "./session.ts";
import {
	type OwnWorkspaceKey,
	reconcileWorkspaceKeys,
} from "./workspace-keys.ts";

export type WorkspaceKeyMaterial = {
	workspaceId: string;
	keyVersion: number;
	commitment: string;
	wdk: Uint8Array;
};

export type KeyringContextValue = {
	state: KeyringState;
	/** False until the first identity fetch settles, so callers do not flash. */
	ready: boolean;
	/** False when the deployment has the feature off (the route 404s). */
	available: boolean;
	identity: IdentityResponse | null;
	/** True when the last transition to `locked` was the max age, not the user. */
	lockedByTimeout: boolean;
	unlock: (secret: string, remember: boolean) => Promise<void>;
	lockNow: () => void;
	/**
	 * Re-reads the identity and takes an already-unwrapped private key
	 * against it. Enrollment has one; so does a recovery reset, which ends
	 * holding the key it just re-wrapped. Named for what it does rather than
	 * for the first caller, which is what it was called until the second
	 * arrived.
	 */
	adoptPrivateKey: (privateKey: Uint8Array, remember: boolean) => Promise<void>;
	/** Re-opens and commitment-checks the caller's durable WDK wraps. */
	refreshWorkspaceKeys: () => Promise<void>;
	/** The active, verified key for invite/file encryption, or null while absent. */
	workspaceKey: (
		workspaceId: string,
		keyVersion?: number,
	) => Promise<WorkspaceKeyMaterial | null>;
	/** Fast-invite handoff after its fragment has passed the commitment check. */
	cacheWorkspaceKey: (
		workspaceId: string,
		keyVersion: number,
		wdk: Uint8Array,
	) => void;
	/** Needed only to seal a fast-invite WDK to this user's own identity. */
	privateKey: () => Uint8Array;
	refresh: () => Promise<void>;
};

const KeyringContext = createContext<KeyringContextValue | null>(null);

// The keyring's expiry is evaluated on READ, deliberately (a timer that never
// fires in a backgrounded tab would leave a key readable past its max age).
// Nothing re-renders on its own, so the surfaces that display the state poll
// for it. 15s is granular enough for a control whose shortest option is 15
// minutes, and costs one comparison.
const STATE_POLL_MS = 15_000;

export function KeyringProvider({
	userId,
	autoLockMinutes,
	children,
}: {
	userId: string;
	autoLockMinutes: number | null;
	children: ReactNode;
}) {
	// Declared before the session that closes over it: the closure is only
	// CALLED on unlock, so a later declaration happens to work, but it reads as
	// a use-before-define and the next edit to either is where that stops being
	// true.
	const deriver = useMemo(() => createDeriver(), []);
	useEffect(() => () => deriver.dispose(), [deriver]);

	// Built once. `autoLockMinutes` is applied through setAutoLockMinutes below
	// rather than by rebuilding on change: a rebuild drops the unlocked key, so
	// choosing a LONGER timeout would lock the user out -- the opposite of the
	// request. The initial max age is therefore the domain default and the
	// effect corrects it on the first commit.
	const keyring = useMemo(
		() =>
			createKeyring({
				now: () => Date.now(),
				maxAgeMs: autoLockMaxAgeMs(null),
				derive: (secret, salt, version) =>
					deriver.derive(secret, salt, "passphrase", version),
			}),
		[deriver],
	);
	const session = useMemo(
		() => createSession(keyring, () => deviceId()),
		[keyring],
	);

	const [state, setState] = useState<KeyringState>("unenrolled");
	const [identity, setIdentity] = useState<IdentityResponse | null>(null);
	const [ready, setReady] = useState(false);
	const [available, setAvailable] = useState(true);
	const [lockedByTimeout, setLockedByTimeout] = useState(false);
	const workspaceKeys = useRef<OwnWorkspaceKey[]>([]);
	const hydration = useRef<Promise<void> | null>(null);
	const hydrationAbort = useRef<AbortController | null>(null);
	const refreshAbort = useRef<AbortController | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		const abortReads = () => {
			hydrationAbort.current?.abort();
			refreshAbort.current?.abort();
		};
		mounted.current = true;
		window.addEventListener("beforeunload", abortReads);
		window.addEventListener("pagehide", abortReads);
		return () => {
			mounted.current = false;
			abortReads();
			window.removeEventListener("beforeunload", abortReads);
			window.removeEventListener("pagehide", abortReads);
		};
	}, []);
	// Read in the poll, which must not re-subscribe every time the state moves.
	const previous = useRef<KeyringState>("unenrolled");
	const userLocked = useRef(false);

	const sync = useCallback(() => {
		const next = session.state();
		if (next !== previous.current) {
			// Ready -> locked with no lock-now in between is the max age firing.
			// The reason is stated where the user meets it rather than as a toast
			// they may have missed.
			if (previous.current === "ready" && next === "locked") {
				setLockedByTimeout(!userLocked.current);
			}
			if (next === "ready") setLockedByTimeout(false);
			userLocked.current = false;
			previous.current = next;
		}
		setState(next);
	}, [session]);

	const hydrateWorkspaceKeys = useCallback(
		async (publicKey: string | null) => {
			if (!publicKey || keyring.state() !== "ready") return;
			if (hydration.current) return await hydration.current;
			const controller = new AbortController();
			hydrationAbort.current = controller;
			const run = (async () => {
				try {
					workspaceKeys.current = await reconcileWorkspaceKeys(
						keyring,
						userId,
						publicKey,
						(input, init) =>
							fetch(input, { ...init, signal: controller.signal }),
					);
				} catch (error) {
					// Navigation aborts in-flight fetches while this provider unmounts.
					// That is neither a key failure nor useful console noise.
					if (mounted.current && !controller.signal.aborted)
						console.error("e2e: workspace key refresh failed", error);
				}
			})();
			hydration.current = run;
			try {
				await run;
			} finally {
				if (hydration.current === run) hydration.current = null;
				if (hydrationAbort.current === controller)
					hydrationAbort.current = null;
			}
		},
		[keyring, userId],
	);

	const refresh = useCallback(async () => {
		refreshAbort.current?.abort();
		const controller = new AbortController();
		refreshAbort.current = controller;
		try {
			const response = await fetch("/api/e2e/identity", {
				credentials: "include",
				signal: controller.signal,
			});
			if (!response.ok) {
				// 404 is the feature being off, which is not an error state and
				// must not render as one.
				setAvailable(response.status !== 404);
				setIdentity(null);
				await session.adoptIdentity(userId, null);
				return;
			}
			setAvailable(true);
			const body = (await response.json()) as IdentityResponse;
			setIdentity(body);
			await session.adoptIdentity(userId, body);
			await hydrateWorkspaceKeys(body.publicKey);
		} catch (error) {
			if (!controller.signal.aborted) {
				console.error(error);
				setIdentity(null);
			}
		} finally {
			if (refreshAbort.current === controller) refreshAbort.current = null;
			if (!controller.signal.aborted) {
				setReady(true);
				sync();
			}
		}
	}, [hydrateWorkspaceKeys, session, sync, userId]);

	useEffect(() => {
		void refresh();
		return () => refreshAbort.current?.abort();
	}, [refresh]);

	useEffect(() => {
		session.setAutoLockMinutes(autoLockMinutes);
		sync();
	}, [autoLockMinutes, session, sync]);

	useEffect(() => {
		const timer = setInterval(sync, STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [sync]);

	const value = useMemo<KeyringContextValue>(
		() => ({
			state,
			ready,
			available,
			identity,
			lockedByTimeout,
			async unlock(secret, remember) {
				try {
					await session.unlock(secret, remember);
					await hydrateWorkspaceKeys(identity?.publicKey ?? null);
				} finally {
					sync();
				}
			},
			lockNow() {
				userLocked.current = true;
				session.lockNow();
				sync();
			},
			async adoptPrivateKey(privateKey, remember) {
				const response = await fetch("/api/e2e/identity", {
					credentials: "include",
				});
				if (!response.ok) return;
				const body = (await response.json()) as IdentityResponse;
				setIdentity(body);
				await session.enrolled(userId, body, privateKey, remember);
				await hydrateWorkspaceKeys(body.publicKey);
				sync();
			},
			async refreshWorkspaceKeys() {
				await hydrateWorkspaceKeys(identity?.publicKey ?? null);
			},
			async workspaceKey(workspaceId, keyVersion) {
				await hydrateWorkspaceKeys(identity?.publicKey ?? null);
				const row = workspaceKeys.current.find(
					(candidate) =>
						candidate.workspaceId === workspaceId &&
						(keyVersion === undefined
							? candidate.active
							: candidate.keyVersion === keyVersion),
				);
				if (!row) return null;
				const wdk = keyring.wdkFor(row.workspaceId, row.keyVersion);
				return wdk
					? {
							workspaceId: row.workspaceId,
							keyVersion: row.keyVersion,
							commitment: row.commitment,
							wdk,
						}
					: null;
			},
			cacheWorkspaceKey(workspaceId, keyVersion, wdk) {
				keyring.putWdk(workspaceId, keyVersion, wdk);
			},
			privateKey: keyring.privateKey,
			refresh,
		}),
		[
			available,
			identity,
			hydrateWorkspaceKeys,
			keyring,
			lockedByTimeout,
			ready,
			refresh,
			session,
			state,
			sync,
			userId,
		],
	);

	return (
		<KeyringContext.Provider value={value}>{children}</KeyringContext.Provider>
	);
}

export function useKeyring(): KeyringContextValue {
	const value = useContext(KeyringContext);
	if (!value) throw new Error("useKeyring: no KeyringProvider above this tree");
	return value;
}
