"use client";

import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { m } from "../../../paraglide/messages.js";

export type ConfirmOptions = {
	title?: string;
	body: string;
	confirmLabel: string;
	destructive?: boolean;
};

const ConfirmContext = createContext<
	((options: ConfirmOptions) => Promise<boolean>) | null
>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<ConfirmOptions | null>(null);
	// Invariant: every promise returned by confirm() settles exactly once. The
	// resolver lives in a ref (not in state next to the options) so settle() is
	// identity-stable and can never resolve a stale one; clearing the ref before
	// calling it is what makes "exactly once" hold across Escape, Cancel, the
	// action button and an overlay dismiss all racing the same close.
	const resolverRef = useRef<((ok: boolean) => void) | null>(null);

	const confirm = useCallback(
		(options: ConfirmOptions) =>
			new Promise<boolean>((resolve) => {
				// A confirm raised while another is pending cancels the outgoing one
				// rather than leaving its caller awaiting a promise nothing can settle.
				resolverRef.current?.(false);
				resolverRef.current = resolve;
				setPending(options);
			}),
		[],
	);

	const settle = useCallback((ok: boolean) => {
		const resolve = resolverRef.current;
		resolverRef.current = null;
		setPending(null);
		resolve?.(ok);
	}, []);

	return (
		<ConfirmContext.Provider value={confirm}>
			{children}
			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) settle(false);
				}}
			>
				{pending && (
					<AlertDialogContent data-testid="confirm-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>
								{pending.title ?? m.confirm_default_title()}
							</AlertDialogTitle>
							<AlertDialogDescription>{pending.body}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel
								data-testid="confirm-cancel"
								onClick={() => settle(false)}
							>
								{m.confirm_cancel()}
							</AlertDialogCancel>
							<AlertDialogAction
								data-testid="confirm-accept"
								variant={pending.destructive ? "destructive" : "default"}
								onClick={() => settle(true)}
							>
								{pending.confirmLabel}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				)}
			</AlertDialog>
		</ConfirmContext.Provider>
	);
}

export function useConfirm() {
	const confirm = useContext(ConfirmContext);
	// Fail loud: a missing provider would otherwise silently make every
	// destructive action either always-proceed or never-proceed.
	if (!confirm) throw new Error("useConfirm requires a ConfirmProvider");
	return confirm;
}
