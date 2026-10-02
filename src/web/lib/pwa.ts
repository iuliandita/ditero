export function canRegisterPwa(
	location: Pick<Location, "protocol" | "hostname">,
	native: boolean,
	production: boolean,
): boolean {
	return (
		production &&
		!native &&
		(location.protocol === "https:" ||
			(location.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)))
	);
}

export async function activatePwaUpdate(
	worker: Pick<ServiceWorker, "postMessage" | "state">,
	retire: () => Promise<void>,
	container: Pick<
		ServiceWorkerContainer,
		"addEventListener" | "removeEventListener" | "controller"
	>,
	reload: () => void,
): Promise<void> {
	let observedActivation = false;
	let finishActivation: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const changed = () => {
		observedActivation = true;
		finishActivation?.();
	};
	// Another tab may activate this update while accepted edits are being saved.
	container.addEventListener("controllerchange", changed);
	try {
		await retire();
		if (
			!observedActivation &&
			worker.state !== "activated" &&
			container.controller !== worker
		) {
			await new Promise<void>((resolve, reject) => {
				finishActivation = resolve;
				timer = setTimeout(
					() => reject(new Error("PWA activation timed out")),
					15_000,
				);
				worker.postMessage({ type: "ACTIVATE_UPDATE" });
			});
		}
		// Activation alone never authorizes reload before durable retirement.
		reload();
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		container.removeEventListener("controllerchange", changed);
	}
}

export async function registerPwa(
	onUpdate: (worker: ServiceWorker) => void,
): Promise<void> {
	if (
		!canRegisterPwa(
			window.location,
			"NativeDitero" in globalThis,
			import.meta.env.PROD,
		) ||
		!("serviceWorker" in navigator)
	)
		return;
	const registration = await navigator.serviceWorker.register("/sw.js", {
		type: "module",
		scope: "/",
		updateViaCache: "none",
	});
	if (registration.waiting) onUpdate(registration.waiting);
	registration.addEventListener("updatefound", () => {
		const installing = registration.installing;
		installing?.addEventListener("statechange", () => {
			if (
				installing.state === "installed" &&
				navigator.serviceWorker.controller &&
				registration.waiting
			)
				onUpdate(registration.waiting);
		});
	});
}
