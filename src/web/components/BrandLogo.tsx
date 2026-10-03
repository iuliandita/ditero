import darkWordmark from "../../../assets/brand/ditero-wordmark-dark.png";
import lightWordmark from "../../../assets/brand/ditero-wordmark-light.png";
import { cn } from "../lib/utils.ts";

export function BrandLogo({ className }: { className?: string }) {
	return (
		<span className={cn("inline-block w-36 max-w-full", className)}>
			<span className="sr-only">Ditero</span>
			<img
				src={lightWordmark}
				alt=""
				aria-hidden="true"
				width={2172}
				height={724}
				className="h-auto w-full dark:hidden"
			/>
			<img
				src={darkWordmark}
				alt=""
				aria-hidden="true"
				width={2172}
				height={724}
				className="hidden h-auto w-full dark:block"
			/>
		</span>
	);
}
