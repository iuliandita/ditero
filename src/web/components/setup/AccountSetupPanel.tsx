import { useEffect, useRef } from "react";
import { ACCOUNT_SETUP_CATALOG_VERSION } from "../../../domain/account-setup.ts";
import { createSetupPackCatalog } from "../../../domain/setup-packs.ts";
import { m } from "../../../paraglide/messages.js";
import type { useAccountSetup } from "../../hooks/useAccountSetup.ts";
import { Button } from "../ui/button.tsx";
import {
	AccountSetupWizard,
	type AccountSetupWizardLabels,
} from "./AccountSetupWizard.tsx";

export function AccountSetupPanel({
	setup,
	expanded,
	onOpen,
	onLeave,
}: {
	setup: ReturnType<typeof useAccountSetup>;
	expanded: boolean;
	onOpen: () => void;
	onLeave: () => void;
}) {
	const container = useRef<HTMLFieldSetElement>(null);
	useEffect(() => {
		if (expanded) container.current?.focus();
	}, [expanded]);
	if (setup.managed)
		return <p className="text-sm text-muted-foreground">{m.setup_managed()}</p>;
	if (!expanded)
		return (
			<Button variant="outline" onClick={onOpen} className="min-h-11">
				{m.setup_open()}
			</Button>
		);
	const labels: AccountSetupWizardLabels = {
		title: m.setup_title(),
		description: m.setup_description(),
		choices: m.setup_choices(),
		recommended: m.setup_recommended(),
		basic: m.setup_basic(),
		basicDescription: m.setup_basic_description(),
		guided: m.setup_guided(),
		guidedDescription: m.setup_guided_description(),
		custom: m.setup_custom(),
		customDescription: m.setup_custom_description(),
		preview: m.setup_preview(),
		dashboard: m.setup_dashboard(),
		emptyPreview: m.setup_empty_preview(),
		chooseContent: m.setup_choose_content(),
		continue: m.setup_continue(),
		back: m.setup_back(),
		apply: m.setup_apply(),
		startEmpty: m.setup_start_empty(),
		countersHint: m.setup_counters_hint(),
		skip: m.setup_skip(),
		loading: m.setup_loading(),
		applying: m.setup_applying(),
		failed: m.setup_failed(),
		retry: m.setup_retry(),
		resume: m.setup_resume(),
		completed: m.setup_completed(),
		leave: m.setup_leave(),
		taskCount: (count) => m.setup_task_count({ count }),
	};
	const error =
		!setup.error || setup.error === "loading"
			? undefined
			: setup.error === "offline"
				? m.setup_offline()
				: [
							"request-conflict",
							"revision-conflict",
							"already-completed",
							"apply-required",
						].includes(setup.error)
					? m.setup_conflict()
					: m.setup_failed();
	return (
		<fieldset
			ref={container}
			tabIndex={-1}
			aria-label={m.setup_title()}
			className="scroll-mt-20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
		>
			<AccountSetupWizard
				key={`${setup.requestId}:${setup.locale}`}
				catalog={createSetupPackCatalog(
					setup.locale,
					ACCOUNT_SETUP_CATALOG_VERSION,
				)}
				requestId={setup.requestId}
				expectedRevision={setup.expectedRevision}
				labels={labels}
				state={setup.state}
				error={error}
				allowEmptyChoice={setup.allowEmptyChoice}
				emptyChoiceReason={m.setup_empty_already()}
				onSubmit={setup.submit}
				onRetry={setup.retry}
				onResume={setup.resume}
				onLeave={onLeave}
			/>
			<div className="space-y-3 px-4 pb-4 text-sm text-muted-foreground sm:px-6 sm:pb-6">
				<p>{m.setup_personal_hint()}</p>
				{(setup.state === "completed" || setup.state === "conflict") &&
					(setup.outcome === "custom" || setup.outcome === "skipped") &&
					(!setup.request ||
						setup.revision > setup.request.expectedRevision) && (
						<div className="space-y-2">
							<Button
								variant="outline"
								className="min-h-11"
								disabled={!setup.authoritative || !setup.online}
								onClick={() => {
									container.current?.focus();
									setup.fresh();
								}}
							>
								{m.setup_open()}
							</Button>
							{!setup.online && <p>{m.setup_offline()}</p>}
							{!setup.authoritative && <p>{m.setup_loading()}</p>}
						</div>
					)}
				{setup.state !== "completed" && (
					<Button variant="ghost" className="min-h-11" onClick={onLeave}>
						{m.setup_leave()}
					</Button>
				)}
			</div>
		</fieldset>
	);
}
