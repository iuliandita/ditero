import { useEffect, useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import {
	type NativePush,
	type NativePushState,
	useNativeAccount,
} from "../../lib/native-account.tsx";
import { Button } from "../ui/button.tsx";

function statusText(state: NativePushState["state"]): string {
	switch (state) {
		case "disabled":
			return m.native_push_disabled();
		case "enabling":
			return m.native_push_enabling();
		case "active":
			return m.native_push_active();
		case "denied":
			return m.native_push_denied();
		case "missing-distributor":
			return m.native_push_missing_distributor();
		case "server-unavailable":
			return m.native_push_server_unavailable();
		case "registration-failed":
			return m.native_push_registration_failed();
		case "temporary-unavailable":
			return m.native_push_temporary_unavailable();
		case "cleanup-pending":
			return m.native_push_cleanup_pending();
		case "storage-failed":
			return m.native_push_storage_failed();
		case "no-session":
			return m.native_push_no_session();
	}
}

function PhonePush({ push }: { push: NativePush }) {
	const [snapshot, setSnapshot] = useState<NativePushState | null>(null);
	const [busy, setBusy] = useState(false);
	const [reading, setReading] = useState(false);
	const [failed, setFailed] = useState<"read" | "action" | null>(null);
	const owner = useRef(0);
	const inFlight = useRef(false);
	const lastState = useRef<NativePushState | null>(null);
	const pollBudget = useRef(0);
	const [revision, setRevision] = useState(0);

	// Manual refresh and completed gestures restart this bounded observation.
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit refresh trigger.
	useEffect(() => {
		const epoch = ++owner.current;
		inFlight.current = false;
		pollBudget.current = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = Date.now() + 15_000;
		const current = () => epoch === owner.current;
		const schedule = () => {
			if (
				document.visibilityState === "hidden" ||
				!current() ||
				(lastState.current?.state !== "enabling" &&
					lastState.current?.state !== "cleanup-pending") ||
				pollBudget.current >= 10 ||
				Date.now() >= deadline
			)
				return;
			timer = setTimeout(() => {
				if (
					(lastState.current?.state !== "enabling" &&
						lastState.current?.state !== "cleanup-pending") ||
					Date.now() >= deadline
				)
					return;
				pollBudget.current++;
				void read();
			}, 1000);
		};
		const read = async () => {
			if (inFlight.current || document.visibilityState === "hidden") return;
			inFlight.current = true;
			setReading(true);
			try {
				const next = await push.read();
				if (!current()) return;
				lastState.current = next;
				setSnapshot(next);
				setFailed(null);
			} catch {
				if (current()) setFailed("read");
			} finally {
				if (current()) {
					inFlight.current = false;
					setReading(false);
					schedule();
				}
			}
		};
		const visible = () => {
			if (timer) clearTimeout(timer);
			if (document.visibilityState !== "hidden") void read();
		};
		document.addEventListener("visibilitychange", visible);
		void read();
		return () => {
			owner.current++;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [push, revision]);

	async function act(action: "enable" | "disable" | "permission") {
		if (inFlight.current) return;
		const epoch = owner.current;
		inFlight.current = true;
		setBusy(true);
		setFailed(null);
		try {
			const next = await push[action]();
			if (epoch !== owner.current) return;
			lastState.current = next;
			setSnapshot(next);
		} catch {
			if (epoch === owner.current) setFailed("action");
		} finally {
			if (epoch === owner.current) {
				inFlight.current = false;
				setBusy(false);
				if (
					lastState.current?.state === "enabling" ||
					lastState.current?.state === "cleanup-pending"
				)
					setRevision((value) => value + 1);
			}
		}
	}
	const state = snapshot?.state;
	const cleanup = state === "cleanup-pending";
	const controls = {
		enable:
			!!snapshot &&
			state !== "no-session" &&
			!cleanup &&
			state !== "active" &&
			state !== "enabling",
		permission:
			snapshot?.permission === "denied" && state !== "no-session" && !cleanup,
		disable: !!snapshot && state !== "disabled" && state !== "no-session",
	};
	return (
		<section aria-labelledby="native-push-heading">
			<h3 id="native-push-heading" className="text-sm font-semibold">
				{m.native_push_heading()}
			</h3>
			<p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
				{m.native_push_help()}
			</p>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="mt-3 max-w-prose text-sm"
			>
				{failed
					? failed === "action"
						? m.native_push_action_failed()
						: m.native_push_read_failed()
					: snapshot
						? statusText(snapshot.state)
						: m.native_push_loading()}
			</p>
			<div className="mt-3 flex flex-wrap gap-2">
				{controls.enable && (
					<Button
						className="min-h-11 h-auto max-w-full whitespace-normal text-start"
						disabled={busy || reading || !snapshot}
						onClick={() => void act("enable")}
					>
						{state === "disabled"
							? m.native_push_enable()
							: m.native_push_retry()}
					</Button>
				)}
				{controls.permission && (
					<Button
						variant="outline"
						className="min-h-11 h-auto max-w-full whitespace-normal text-start"
						disabled={busy || reading}
						onClick={() => void act("permission")}
					>
						{m.native_push_permission()}
					</Button>
				)}
				{controls.disable && (
					<Button
						variant="outline"
						className="min-h-11 h-auto max-w-full whitespace-normal text-start"
						disabled={busy || reading}
						onClick={() => void act("disable")}
					>
						{cleanup ? m.native_push_retry_disable() : m.native_push_disable()}
					</Button>
				)}
				<Button
					variant="ghost"
					className="min-h-11 h-auto max-w-full whitespace-normal text-start"
					disabled={busy || reading}
					onClick={() => {
						if (!inFlight.current) setRevision((value) => value + 1);
					}}
				>
					{m.native_push_refresh()}
				</Button>
			</div>
		</section>
	);
}

export function NativePushSettings() {
	const account = useNativeAccount();
	return account?.push ? (
		<PhonePush key={account.push.identity} push={account.push} />
	) : null;
}
