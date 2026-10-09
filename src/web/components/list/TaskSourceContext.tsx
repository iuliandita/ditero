import { UserRound, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";

export type TaskSourceWorkspace = {
	name: string;
	kind: "personal" | "shared";
};

export function TaskSourceContext({
	context,
	workspace,
	compact = false,
}: {
	context: string;
	workspace?: TaskSourceWorkspace;
	compact?: boolean;
}) {
	const Icon = workspace?.kind === "personal" ? UserRound : UsersRound;
	return (
		<span
			className={cn(
				"min-w-0 max-w-full wrap-anywhere text-xs text-muted-foreground",
				compact && "line-clamp-2",
			)}
			title={context}
			data-testid="task-source-context"
		>
			{workspace ? (
				<>
					<span aria-hidden="true" className="inline-flex items-center gap-1.5">
						<Icon className="size-3 shrink-0" />
						<span>{workspace.name}</span>
					</span>
					<span className="sr-only">{context}</span>
				</>
			) : (
				context
			)}
		</span>
	);
}
