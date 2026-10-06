import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	type ACCOUNT_SETUP_STARTERS,
	type AccountSetupRequest,
	accountSetupRequestSchema,
} from "../../../domain/account-setup.ts";
import type { SetupPackCatalog } from "../../../domain/setup-packs.ts";

type StarterKey = (typeof ACCOUNT_SETUP_STARTERS)[number];
type Mode = "basic" | "guided" | "custom";
export type AccountSetupWizardLabels = {
	title: string;
	description: string;
	choices: string;
	recommended: string;
	basic: string;
	basicDescription: string;
	guided: string;
	guidedDescription: string;
	custom: string;
	customDescription: string;
	preview: string;
	dashboard: string;
	emptyPreview: string;
	chooseContent: string;
	continue: string;
	back: string;
	apply: string;
	startEmpty: string;
	countersHint: string;
	skip: string;
	loading: string;
	applying: string;
	failed: string;
	retry: string;
	resume: string;
	completed: string;
	leave: string;
	taskCount: (count: number) => string;
};
export type AccountSetupWizardProps = {
	catalog: SetupPackCatalog;
	requestId: string;
	expectedRevision: number;
	labels: AccountSetupWizardLabels;
	state:
		| "ready"
		| "loading"
		| "submitting"
		| "uncertain"
		| "conflict"
		| "completed";
	error?: string;
	allowEmptyChoice?: boolean;
	emptyChoiceReason?: string;
	onSubmit: (request: AccountSetupRequest) => Promise<void>;
	onRetry: () => Promise<void>;
	onResume: () => Promise<void>;
	onLeave: () => void;
};

export function AccountSetupWizard({
	catalog,
	requestId,
	expectedRevision,
	labels,
	state,
	error,
	allowEmptyChoice = true,
	emptyChoiceReason,
	onSubmit,
	onRetry,
	onResume,
	onLeave,
}: AccountSetupWizardProps) {
	const id = useId();
	const [mode, setMode] = useState<Mode>("basic");
	const [keys, setKeys] = useState<StarterKey[]>(["shopping", "cleaning"]);
	const [dashboard, setDashboard] = useState(true);
	const [review, setReview] = useState(false);
	const [localBusy, setLocalBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const flight = useRef(false);
	const reviewHeading = useRef<HTMLHeadingElement>(null);
	const choicesHeading = useRef<HTMLLegendElement>(null);
	const focusTransition = useRef(false);
	useEffect(() => {
		if (!focusTransition.current) return;
		focusTransition.current = false;
		(review ? reviewHeading.current : choicesHeading.current)?.focus();
	}, [review]);
	function showReview(value: boolean) {
		focusTransition.current = true;
		setReview(value);
	}
	const busy = localBusy || state === "loading" || state === "submitting";
	const editable = !busy && state === "ready";
	const selected =
		mode === "basic" ? ["shopping", "cleaning"] : mode === "guided" ? keys : [];
	const hasDashboard = mode === "basic" || (mode === "guided" && dashboard);
	const packs = catalog.packs.filter((pack) => selected.includes(pack.key));
	const valid =
		(mode !== "custom" || allowEmptyChoice) &&
		(mode !== "guided" || keys.length > 0 || dashboard);
	async function invoke(action: () => Promise<void>) {
		if (flight.current || busy) return;
		flight.current = true;
		setLocalBusy(true);
		setFailed(false);
		try {
			await action();
		} catch {
			setFailed(true);
		} finally {
			flight.current = false;
			setLocalBusy(false);
		}
	}
	function submit(skip = false) {
		if (!editable || (skip && !allowEmptyChoice) || (!skip && !valid)) return;
		void invoke(async () => {
			const common = {
				requestId,
				expectedRevision,
				catalogVersion: catalog.catalogVersion,
				locale: catalog.locale,
			};
			const request = accountSetupRequestSchema.parse(
				skip
					? { ...common, mode: "skip" }
					: mode === "guided"
						? { ...common, mode, starterKeys: keys, dashboard }
						: { ...common, mode },
			);
			await onSubmit(request);
		});
	}
	return (
		<section
			aria-labelledby={`${id}-title`}
			aria-busy={busy}
			className="mx-auto w-full max-w-3xl space-y-6 p-4 text-start sm:p-6"
		>
			<header className="space-y-2">
				<h3 id={`${id}-title`} className="text-base font-semibold text-balance">
					{labels.title}
				</h3>
				<p className="max-w-prose text-sm text-muted-foreground">
					{labels.description}
				</p>
			</header>
			{state === "completed" ? (
				<div className="space-y-4">
					<p role="status">{labels.completed}</p>
					<Button className="min-h-11" onClick={onLeave}>
						{labels.leave}
					</Button>
				</div>
			) : (
				<>
					<div role="status" aria-live="polite">
						{state === "loading"
							? labels.loading
							: busy
								? labels.applying
								: null}
					</div>
					{(error || failed) && (
						<p role="alert" className="text-sm text-destructive">
							{error || labels.failed}
						</p>
					)}
					{state === "uncertain" || state === "conflict" ? (
						<div className="flex flex-wrap gap-3">
							<Button
								className="min-h-11"
								disabled={busy}
								onClick={() => void invoke(onResume)}
							>
								{labels.resume}
							</Button>
							{state === "uncertain" && (
								<Button
									variant="outline"
									className="min-h-11"
									disabled={busy}
									onClick={() => void invoke(onRetry)}
								>
									{labels.retry}
								</Button>
							)}
						</div>
					) : (
						<>
							{!review && (
								<fieldset disabled={!editable} className="space-y-3">
									<legend
										ref={choicesHeading}
										tabIndex={-1}
										className="mb-3 scroll-mt-20 font-medium"
									>
										{labels.choices}
									</legend>
									{(["basic", "guided", "custom"] as const).map((choice) => (
										<label
											key={choice}
											className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-4 focus-within:ring-2 focus-within:ring-ring ${mode === choice ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
										>
											<input
												type="radio"
												name={`${id}-mode`}
												value={choice}
												checked={mode === choice}
												disabled={choice === "custom" && !allowEmptyChoice}
												onChange={() => setMode(choice)}
												className="mt-1 accent-primary"
											/>
											<span className="min-w-0 space-y-1">
												<span className="flex flex-wrap items-center gap-2 font-medium">
													{labels[choice]}
													{choice === "basic" && (
														<span className="rounded bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
															{labels.recommended}
														</span>
													)}
												</span>
												<span className="block text-sm text-muted-foreground">
													{labels[`${choice}Description`]}
													{choice === "custom" &&
														!allowEmptyChoice &&
														emptyChoiceReason && (
															<span className="block">{emptyChoiceReason}</span>
														)}
												</span>
											</span>
										</label>
									))}
								</fieldset>
							)}
							{mode === "guided" && !review && (
								<fieldset disabled={!editable} className="space-y-2">
									<legend className="mb-2 font-medium">
										{labels.chooseContent}
									</legend>
									{catalog.packs.map((pack) => (
										<label
											key={pack.key}
											className="flex min-h-11 cursor-pointer items-center gap-3"
										>
											<input
												type="checkbox"
												checked={keys.includes(pack.key)}
												onChange={(event) =>
													setKeys((current) =>
														event.target.checked
															? [...current, pack.key]
															: current.filter((key) => key !== pack.key),
													)
												}
												className="accent-primary"
											/>
											<span>{pack.title}</span>
											<span className="text-sm text-muted-foreground">
												{labels.taskCount(pack.content.tasks.length)}
											</span>
										</label>
									))}
									<label className="flex min-h-11 cursor-pointer items-center gap-3">
										<input
											type="checkbox"
											checked={dashboard}
											onChange={(event) => setDashboard(event.target.checked)}
											className="accent-primary"
										/>
										<span>{labels.dashboard}</span>
									</label>
								</fieldset>
							)}
							<section
								aria-labelledby={`${id}-preview`}
								className="space-y-4 border-t border-border pt-5"
							>
								<h4
									ref={reviewHeading}
									tabIndex={-1}
									id={`${id}-preview`}
									className="scroll-mt-20 font-medium"
								>
									{labels.preview}
								</h4>
								{packs.length === 0 && !hasDashboard && (
									<p className="text-sm text-muted-foreground">
										{labels.emptyPreview}
									</p>
								)}
								<div className="grid gap-5 sm:grid-cols-2">
									{packs.map((pack) => (
										<div key={pack.key} className="min-w-0">
											<h5 className="mb-2 font-medium">
												{pack.title}
												<span className="ms-2 text-sm font-normal text-muted-foreground">
													{labels.taskCount(pack.content.tasks.length)}
												</span>
											</h5>
											<ul className="space-y-1 text-sm">
												{pack.content.tasks.map((task) => (
													<li key={task.title} className="break-words">
														{task.title}
														{task.category && (
															<span className="ms-2 text-xs text-muted-foreground">
																{task.category}
															</span>
														)}
													</li>
												))}
											</ul>
										</div>
									))}
								</div>
								{hasDashboard && (
									<div className="space-y-1">
										<h5 className="font-medium">{catalog.dashboard.title}</h5>
										<p className="text-sm text-muted-foreground">
											{catalog.dashboard.openTasksTitle}
										</p>
										<p className="text-sm text-muted-foreground">
											{catalog.dashboard.overdueTitle}
										</p>
										<p className="text-sm text-muted-foreground">
											{labels.countersHint}
										</p>
									</div>
								)}
							</section>
							{!valid && (
								<p className="text-sm text-muted-foreground">
									{labels.chooseContent}
								</p>
							)}
							<footer className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
								{review ? (
									<>
										<Button
											variant="outline"
											className="min-h-11"
											disabled={!editable}
											onClick={() => showReview(false)}
										>
											{labels.back}
										</Button>
										<Button
											className="min-h-11"
											disabled={!editable || !valid}
											onClick={() => submit()}
										>
											{packs.length === 0 && !hasDashboard
												? labels.startEmpty
												: labels.apply}
										</Button>
									</>
								) : (
									<Button
										className="min-h-11"
										disabled={!editable || !valid}
										onClick={() => showReview(true)}
									>
										{labels.continue}
									</Button>
								)}
								<Button
									variant="ghost"
									className="min-h-11"
									disabled={!editable || !allowEmptyChoice}
									onClick={() => submit(true)}
									title={!allowEmptyChoice ? emptyChoiceReason : undefined}
								>
									{labels.skip}
								</Button>
							</footer>
						</>
					)}
				</>
			)}
		</section>
	);
}
