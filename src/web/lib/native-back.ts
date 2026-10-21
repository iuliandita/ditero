export const NATIVE_NAVIGATE_BACK = "ditero:navigate-back";

/** Reuse the topmost Radix layer's Escape policy, including blocked dismissals. */
export function installNativeBack() {
	const back = (event: Event) => {
		const layer = document.querySelector(
			'[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]',
		);
		if (layer) {
			(document.activeElement ?? document.body).dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Escape",
					bubbles: true,
					cancelable: true,
				}),
			);
			event.preventDefault();
		} else if (
			!window.dispatchEvent(
				new Event(NATIVE_NAVIGATE_BACK, { cancelable: true }),
			)
		)
			event.preventDefault();
	};
	window.addEventListener("ditero:native-back", back);
	return () => window.removeEventListener("ditero:native-back", back);
}
