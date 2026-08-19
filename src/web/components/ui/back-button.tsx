import { cva, type VariantProps } from "class-variance-authority";
import { ChevronLeft } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

// The glyph means "reverse", and reverse is rightward in RTL, so it mirrors.
// A horizontal chevron that means "expand" (TaskRow, CompletedSection) must
// NOT use this -- disclosure direction does not follow the reading direction.
const backButtonVariants = cva(
	"flex shrink-0 items-center justify-center rounded-lg",
	{
		variants: {
			// `default` is the 44px touch target the mobile header rows need;
			// `compact` is the inline variant that sits in a dense title row.
			size: { default: "size-11", compact: "size-9" },
		},
		defaultVariants: { size: "default" },
	},
);

function BackButton({
	className,
	size,
	...props
}: React.ComponentProps<"button"> & VariantProps<typeof backButtonVariants>) {
	return (
		<button
			type="button"
			aria-label={m.action_back()}
			className={cn(backButtonVariants({ size, className }))}
			{...props}
		>
			<ChevronLeft className="size-5 rtl:rotate-180" />
		</button>
	);
}

export { BackButton };
