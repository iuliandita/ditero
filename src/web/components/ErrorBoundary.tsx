import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button.tsx";

type Props = {
	children: ReactNode;
	// A changed value clears a caught error, so navigating to another view (or
	// editing the current one) recovers without a manual reset.
	resetKey?: string | null;
	onReset?: () => void;
};
type State = { error: Error | null };

// Catches render errors from the wrapped subtree (e.g. a malformed synced view
// filter that throws in taskMatchesFilter) so one bad view degrades to an
// inline, recoverable message instead of white-screening the whole app.
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidUpdate(prev: Props): void {
		if (this.state.error && prev.resetKey !== this.props.resetKey)
			this.setState({ error: null });
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("view render failed", error, info.componentStack);
	}

	handleReset = (): void => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div
					role="alert"
					className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
				>
					<p className="text-sm font-medium">This view couldn't be rendered.</p>
					<Button variant="outline" size="sm" onClick={this.handleReset}>
						Go home
					</Button>
				</div>
			);
		}
		return this.props.children;
	}
}
