import symbol from "../../../assets/brand/ditero-symbol-teal.png";
import darkWordmark from "../../../assets/brand/ditero-wordmark-dark.png";
import lightWordmark from "../../../assets/brand/ditero-wordmark-light.png";
import { cn } from "../lib/utils.ts";

// `lazy` keeps the theme variant that is not shown (display: none) from being
// fetched: for chrome that renders on every screen, not just sign-in.
export function BrandLogo({
	className,
	lazy,
}: {
	className?: string;
	lazy?: boolean;
}) {
	const loading = lazy ? "lazy" : undefined;
	return (
		<span className={cn("inline-block w-36 max-w-full", className)}>
			<span className="sr-only">Ditero</span>
			<img
				src={lightWordmark}
				alt=""
				aria-hidden="true"
				width={2172}
				height={724}
				loading={loading}
				className="h-auto w-full dark:hidden"
			/>
			<img
				src={darkWordmark}
				alt=""
				aria-hidden="true"
				width={2172}
				height={724}
				loading={loading}
				className="hidden h-auto w-full dark:block"
			/>
		</span>
	);
}

export function BrandSymbol({ className }: { className?: string }) {
	return (
		<span className={cn("inline-block size-6", className)}>
			<span className="sr-only">Ditero</span>
			<img
				src={symbol}
				alt=""
				aria-hidden="true"
				width={1254}
				height={1254}
				loading="lazy"
				className="size-full"
			/>
		</span>
	);
}
