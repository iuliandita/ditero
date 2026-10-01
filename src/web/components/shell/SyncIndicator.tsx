import {
	CloudAlert,
	CloudCheck,
	CloudOff,
	CloudUpload,
	LogIn,
	type LucideIcon,
	Unplug,
} from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { useSyncStatus } from "../../hooks/useSyncStatus.ts";
import type { SyncPhase } from "../../lib/sync-status.ts";
import { retireZeroClients } from "../../lib/zero-lifecycle.ts";

// Distinct shapes per state so color is never the only carrier.
const PHASE: Record<
	SyncPhase,
	{
		icon: LucideIcon;
		tone: string;
		title: () => string;
		detail: () => string;
		announce: boolean;
	}
> = {
	synced: {
		icon: CloudCheck,
		tone: "text-muted-foreground/70",
		title: m.sync_synced_title,
		detail: m.sync_synced_detail,
		announce: false,
	},
	syncing: {
		icon: CloudUpload,
		tone: "text-muted-foreground",
		title: m.sync_syncing_title,
		detail: m.sync_syncing_detail,
		announce: false,
	},
	offline: {
		icon: CloudOff,
		tone: "text-warning",
		title: m.sync_offline_title,
		detail: m.sync_offline_detail,
		announce: true,
	},
	reauth: {
		icon: LogIn,
		tone: "text-warning",
		title: m.sync_reauth_title,
		detail: m.sync_reauth_detail,
		announce: true,
	},
	stopped: {
		icon: Unplug,
		tone: "text-destructive",
		title: m.sync_stopped_title,
		detail: m.sync_stopped_detail,
		announce: true,
	},
	"auth-rejected": {
		icon: CloudAlert,
		tone: "text-warning",
		title: m.sync_auth_rejected_title,
		detail: m.sync_auth_rejected_detail,
		announce: true,
	},
	rejected: {
		icon: CloudAlert,
		tone: "text-destructive",
		title: m.sync_rejected_title,
		detail: m.sync_rejected_detail,
		announce: true,
	},
};

const HOVER_CLOSE_DELAY_MS = 150;

// A quiet status control: the sidebar footer on desktop, the end of the phone
// header. Hover previews the explanation; a click or tap pins it open, which
// is also the keyboard and touch path.
export function SyncIndicator({
	placement,
}: {
	placement: "sidebar" | "header";
}) {
	const { phase, pending, dismissRejection } = useSyncStatus();
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [signingIn, setSigningIn] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const signInPending = useRef(false);
	const closeTimer = useRef<number | undefined>(undefined);
	const state = PHASE[phase];
	const Icon = state.icon;
	const showCount = pending > 0 && phase !== "synced";

	useEffect(() => () => window.clearTimeout(closeTimer.current), []);

	function hoverOpen(event: PointerEvent) {
		if (event.pointerType !== "mouse") return;
		window.clearTimeout(closeTimer.current);
		setOpen(true);
	}
	function hoverClose(event: PointerEvent) {
		if (event.pointerType !== "mouse" || pinned) return;
		closeTimer.current = window.setTimeout(
			() => setOpen(false),
			HOVER_CLOSE_DELAY_MS,
		);
	}

	async function signInAgain() {
		if (signInPending.current) return;
		signInPending.current = true;
		setSigningIn(true);
		setSaveFailed(false);
		try {
			await retireZeroClients();
			window.location.reload();
		} catch {
			setSaveFailed(true);
		} finally {
			signInPending.current = false;
			setSigningIn(false);
		}
	}

	return (
		<>
			<span role="status" className="sr-only">
				{state.announce ? state.title() : ""}
			</span>
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					setPinned(next);
				}}
			>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size={placement === "header" ? "default" : "sm"}
						data-testid="sync-indicator"
						data-phase={phase}
						onPointerEnter={hoverOpen}
						onPointerLeave={hoverClose}
						onClick={(event) => {
							// Radix toggles on click; a click while a hover preview is
							// showing should pin it rather than close it.
							if (open && !pinned) {
								event.preventDefault();
								setPinned(true);
							}
						}}
						className={cn(
							"gap-1 px-1.5",
							placement === "header" && "min-h-11 min-w-11 px-3",
							state.tone,
						)}
					>
						<Icon aria-hidden className="size-4" />
						<span className="sr-only">{state.title()}</span>
						{showCount && (
							<>
								<span aria-hidden className="text-xs font-medium tabular-nums">
									{pending}
								</span>
								<span className="sr-only">
									{m.sync_pending_count({ count: pending })}
								</span>
							</>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					data-testid="sync-popover"
					side={placement === "header" ? "bottom" : "top"}
					align={placement === "header" ? "end" : "start"}
					onOpenAutoFocus={(event) => {
						if (!pinned) event.preventDefault();
					}}
					onPointerEnter={hoverOpen}
					onPointerLeave={hoverClose}
					className="w-64 gap-2 p-3 motion-reduce:animate-none"
				>
					<PopoverHeader>
						<PopoverTitle className="flex items-center gap-2">
							<Icon aria-hidden className={cn("size-4 shrink-0", state.tone)} />
							{state.title()}
						</PopoverTitle>
						<PopoverDescription>{state.detail()}</PopoverDescription>
					</PopoverHeader>
					{showCount && (
						<p
							data-testid="sync-pending"
							className="text-xs text-muted-foreground tabular-nums"
						>
							{m.sync_pending_count({ count: pending })}
						</p>
					)}
					{(phase === "reauth" || saveFailed || signingIn) && (
						<Button
							size="sm"
							className="self-start"
							data-testid="sync-sign-in"
							disabled={signingIn}
							onClick={() => void signInAgain()}
						>
							{m.sync_reauth_action()}
						</Button>
					)}
					{saveFailed && <p role="alert">{m.sync_save_pending_failed()}</p>}
					{phase === "rejected" && (
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							onClick={() => {
								dismissRejection();
								setOpen(false);
							}}
						>
							{m.sync_rejected_dismiss()}
						</Button>
					)}
				</PopoverContent>
			</Popover>
		</>
	);
}
