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
	afterEnroll: (privateKey: Uint8Array, remember: boolean) => Promise<void>;
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
	const session = useMemo(
		() =>
			createSession(
				createKeyring({
					now: () => Date.now(),
					maxAgeMs: autoLockMaxAgeMs(null),
					derive: (secret, salt, version) =>
						deriver.derive(secret, salt, "passphrase", version),
				}),
				() => deviceId(),
			),
		[deriver],
	);

	const [state, setState] = useState<KeyringState>("unenrolled");
	const [identity, setIdentity] = useState<IdentityResponse | null>(null);
	const [ready, setReady] = useState(false);
	const [available, setAvailable] = useState(true);
	const [lockedByTimeout, setLockedByTimeout] = useState(false);
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

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/e2e/identity", {
				credentials: "include",
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
		} catch (error) {
			console.error(error);
			setIdentity(null);
		} finally {
			setReady(true);
			sync();
		}
	}, [session, sync, userId]);

	useEffect(() => {
		void refresh();
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
				} finally {
					sync();
				}
			},
			lockNow() {
				userLocked.current = true;
				session.lockNow();
				sync();
			},
			async afterEnroll(privateKey, remember) {
				const response = await fetch("/api/e2e/identity", {
					credentials: "include",
				});
				if (!response.ok) return;
				const body = (await response.json()) as IdentityResponse;
				setIdentity(body);
				await session.enrolled(userId, body, privateKey, remember);
				sync();
			},
			refresh,
		}),
		[
			available,
			identity,
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
