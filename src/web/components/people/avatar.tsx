import { cn } from "@/lib/utils";

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Decorative avatar: the image carries no alt and the name is always rendered
// (or labelled) adjacently by the caller, so screen readers read the name, not
// this. `size-8` default matches the members panel; callers shrink for stacks.
export function MemberAvatar({
	name,
	image,
	className,
}: {
	name: string;
	image?: string | null;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium",
				className,
			)}
		>
			{image ? (
				<img src={image} alt="" className="size-full object-cover" />
			) : (
				initials(name)
			)}
		</span>
	);
}
