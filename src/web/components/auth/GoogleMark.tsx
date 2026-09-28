import type { SVGProps } from "react";

// The official Google "G" mark, not part of the app's own icon set: brand
// guidelines require the exact multicolor logo on a "Continue with Google"
// control rather than a generic icon. aria-hidden because the button text
// is already the accessible name.
export function GoogleMark(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 18 18"
			aria-hidden="true"
			focusable="false"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				fill="#4285F4"
				d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.6151z"
			/>
			<path
				fill="#34A853"
				d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2582c-.8059.5405-1.8368.8596-3.0477.8596-2.3441 0-4.3282-1.5831-5.0359-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
			/>
			<path
				fill="#FBBC05"
				d="M3.9641 10.71c-.18-.5405-.2822-1.1177-.2822-1.71s.1023-1.1695.2822-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.9641 10.71z"
			/>
			<path
				fill="#EA4335"
				d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"
			/>
		</svg>
	);
}
