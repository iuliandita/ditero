import { useEffect, useRef, useState } from "react";
import { m } from "../../../src/paraglide/messages.js";
import { BootSkeleton } from "../../../src/web/components/shell/AppSkeleton.tsx";
import { Button } from "../../../src/web/components/ui/button.tsx";
import { ConfirmProvider } from "../../../src/web/components/ui/confirm.tsx";
import { Input } from "../../../src/web/components/ui/input.tsx";
import {
	SnackbarProvider,
	useSnackbar,
} from "../../../src/web/components/ui/snackbar.tsx";
import { useUserPref } from "../../../src/web/hooks/useUserPref.ts";
import { DisplayPreferencesProvider } from "../../../src/web/lib/DisplayPreferencesProvider.tsx";
import { KeyringProvider } from "../../../src/web/lib/e2e/KeyringProvider.tsx";
import {
	NativeAccountContext,
	type NativeNotificationNavigation,
	type NativePush,
} from "../../../src/web/lib/native-account.tsx";
import { AppZeroProvider } from "../../../src/web/lib/zero.tsx";
import { retireZeroClients } from "../../../src/web/lib/zero-lifecycle.ts";
import { Workspace } from "../../../src/web/routes/Workspace.tsx";
import {
	bridgeState,
	completeOnce,
	connectBridge,
	createNativeNotificationNavigation,
	createNativePush,
	installNativeWebSocket,
	NativeError,
	type NativeProfile,
	openBrowser,
	readBridgeState,
	readProfile,
	requestGrant,
	selectServer,
} from "./bridge.ts";
import {
	captureVerifiedContext,
	createNativeRuntime,
	type NativeContext,
	type NativeRuntimes,
} from "./runtime.ts";

type Active = {
	runtime: NativeRuntimes;
	profile: NativeProfile;
	origin: string;
	push: NativePush;
	notifications: NativeNotificationNavigation;
};

function NativeWorkspace({ active }: { active: Active }) {
	const { pref } = useUserPref();
	return (
		<KeyringProvider
			key={active.runtime.scope}
			userId={active.profile.id}
			storageScope={active.runtime.scope}
			runtime={active.runtime.e2e}
			autoLockMinutes={pref.e2eAutoLockMinutes}
		>
			<Workspace />
		</KeyringProvider>
	);
}

export function NativeApp() {
	return (
		<ConfirmProvider>
			<SnackbarProvider>
				<NativeAppRoutes />
			</SnackbarProvider>
		</ConfirmProvider>
	);
}

function NativeAppRoutes() {
	const { show } = useSnackbar();
	const [restart, setRestart] = useState(0);
	const [active, setActive] = useState<Active | null>(null);
	const [origin, setOrigin] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [approval, setApproval] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const epoch = useRef(0);

	async function activate(owner: number) {
		let context: NativeContext;
		let profile: NativeProfile;
		try {
			context = await captureVerifiedContext();
			profile = await readProfile();
		} catch (error) {
			if (
				error instanceof NativeError &&
				["no-session", "unauthorized"].includes(error.code)
			) {
				const snapshot = await readBridgeState();
				if (!snapshot.session && owner === epoch.current) {
					await retireZeroClients();
					if (owner !== epoch.current) return;
					setActive(null);
					setApproval(false);
					return;
				}
			}
			throw error;
		}
		if (owner !== epoch.current) return;
		const current = bridgeState();
		if (
			current.gen !== context.gen ||
			current.session?.scope !== context.scope ||
			profile.id !== context.userId
		)
			throw new Error("native account changed during startup");
		const runtime = createNativeRuntime(context, {
			retireZero: () => retireZeroClients(),
			onSessionEndFailed() {
				show({ message: m.security_error_sign_out() });
				const current = bridgeState();
				if (
					current.session &&
					(current.gen !== context.gen ||
						current.session.authHandle !== context.authHandle)
				) {
					void activate(++epoch.current).catch(() =>
						setError(m.native_connect_failed()),
					);
				} else if (current.session) setRestart((value) => value + 1);
				else {
					epoch.current++;
					setActive(null);
					setApproval(false);
				}
			},
			onSessionEnded() {
				epoch.current++;
				setActive(null);
				setApproval(false);
			},
		});
		await retireZeroClients();
		if (owner !== epoch.current) return;
		setApproval(false);
		setActive({
			runtime,
			profile,
			origin: context.origin,
			push: createNativePush(context.gen, context.authHandle),
			notifications: createNativeNotificationNavigation(
				context.gen,
				context.authHandle,
			),
		});
	}

	useEffect(() => {
		const owner = ++epoch.current;
		let restoreSocket: (() => void) | undefined;
		void (async () => {
			const hello = await connectBridge();
			if (owner !== epoch.current) return;
			restoreSocket = installNativeWebSocket();
			setOrigin(hello.server?.origin ?? "");
			if (hello.session) await activate(owner);
		})()
			.catch(() => {
				if (owner === epoch.current) setError(m.native_connect_failed());
			})
			.finally(() => {
				if (owner === epoch.current) setLoading(false);
			});
		return () => {
			epoch.current++;
			restoreSocket?.();
		};
	}, []);

	async function connect() {
		if (busy) return;
		const owner = ++epoch.current;
		setBusy(true);
		setError(null);
		setPending(false);
		try {
			await retireZeroClients();
			const next = await selectServer(origin.trim());
			setOrigin(next.server?.origin ?? origin);
			if (next.session) await activate(owner);
			else {
				await requestGrant();
				await openBrowser();
				if (owner === epoch.current) setApproval(true);
			}
		} catch {
			if (owner === epoch.current) setError(m.native_connect_failed());
		} finally {
			if (owner === epoch.current) setBusy(false);
		}
	}

	async function finish() {
		if (busy) return;
		const owner = epoch.current;
		setBusy(true);
		setError(null);
		setPending(false);
		try {
			const result = await completeOnce();
			if (result === "pending" || result === "finishing") setPending(true);
			else await activate(owner);
		} catch {
			if (owner === epoch.current) setError(m.native_signin_failed());
		} finally {
			if (owner === epoch.current) setBusy(false);
		}
	}

	async function changeServer() {
		await retireZeroClients();
		epoch.current++;
		setActive(null);
		setApproval(false);
		setError(null);
		setPending(false);
	}

	return (
		<>
			{loading ? (
				<BootSkeleton />
			) : active ? (
				<NativeAccountContext
					value={{
						profile: active.profile,
						origin: active.origin,
						storageScope: active.runtime.scope,
						push: active.push,
						notifications: active.notifications,
						changeServer,
					}}
				>
					<DisplayPreferencesProvider
						key={active.runtime.scope}
						userId={active.runtime.scope}
					>
						<AppZeroProvider
							key={`${active.runtime.scope}:${restart}`}
							userID={active.profile.id}
							runtime={active.runtime.zero}
						>
							<NativeWorkspace active={active} />
						</AppZeroProvider>
					</DisplayPreferencesProvider>
				</NativeAccountContext>
			) : (
				<DisplayPreferencesProvider userId={null}>
					<main className="flex min-h-dvh items-center justify-center px-6 py-10">
						<div className="w-full max-w-sm space-y-6">
							<div className="space-y-2">
								<p className="text-sm font-medium text-muted-foreground">
									Ditero
								</p>
								<h1 className="text-2xl font-semibold tracking-tight">
									{m.native_connect_title()}
								</h1>
								<p className="text-sm leading-relaxed text-muted-foreground">
									{approval
										? m.native_approval_intro()
										: m.native_connect_intro()}
								</p>
							</div>
							{approval ? (
								<div className="space-y-3">
									<p className="break-all text-sm text-muted-foreground">
										{origin}
									</p>
									<Button
										className="min-h-11 w-full"
										disabled={busy}
										onClick={() => void finish()}
									>
										{m.native_finish_signin()}
									</Button>
									<Button
										variant="outline"
										className="min-h-11 w-full"
										disabled={busy}
										onClick={() => {
											void openBrowser().catch(() =>
												setError(m.native_signin_failed()),
											);
										}}
									>
										{m.native_browser_signin()}
									</Button>
									<Button
										variant="ghost"
										className="min-h-11 w-full"
										disabled={busy}
										onClick={() => setApproval(false)}
									>
										{m.native_change_server()}
									</Button>
								</div>
							) : (
								<form
									className="space-y-3"
									onSubmit={(event) => {
										event.preventDefault();
										void connect();
									}}
								>
									<label
										htmlFor="native-server"
										className="block text-sm font-medium"
									>
										{m.native_authorize_server_label()}
									</label>
									<Input
										id="native-server"
										type="url"
										value={origin}
										placeholder="https://example.com"
										autoComplete="url"
										autoCapitalize="none"
										spellCheck={false}
										required
										disabled={busy}
										onChange={(event) => setOrigin(event.target.value)}
									/>
									<Button
										type="submit"
										className="min-h-11 w-full"
										disabled={busy || !origin.trim()}
									>
										{m.native_connect_action()}
									</Button>
								</form>
							)}
							{pending && (
								<p role="status" className="text-sm text-muted-foreground">
									{m.native_approval_pending()}
								</p>
							)}
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
						</div>
					</main>
				</DisplayPreferencesProvider>
			)}
		</>
	);
}
