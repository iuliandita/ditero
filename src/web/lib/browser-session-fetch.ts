import {
	BROWSER_SESSION_CHANGED,
	BROWSER_SESSION_GENERATION_KEY,
	BROWSER_SESSION_KEY,
	browserSessionGeneration,
	browserSessionStorageGeneration,
	forgetBrowserSession,
	invalidateBrowserSessionRequests,
	isSessionRefusal,
	rememberBrowserSession,
} from "./browser-session.ts";

// Capture authority at dispatch, not when React later observes a session result.
export function createBrowserSessionFetch(
	network: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	const verifications = new Set<Promise<Response>>();
	if (typeof window !== "undefined")
		window.addEventListener("storage", (event) => {
			if (
				event.key === BROWSER_SESSION_KEY ||
				event.key === BROWSER_SESSION_GENERATION_KEY ||
				event.key === null
			) {
				invalidateBrowserSessionRequests();
				window.dispatchEvent(new Event(BROWSER_SESSION_CHANGED));
			}
		});
	return async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		const path = new URL(url, window.location.origin).pathname;
		const changing =
			path.endsWith("/sign-out") ||
			path.endsWith("/delete-user") ||
			path.includes("/sign-in/") ||
			path.includes("/sign-up/");
		const signingOut =
			path.endsWith("/sign-out") || path.endsWith("/delete-user");
		if (changing) forgetBrowserSession();
		const epoch = browserSessionGeneration();
		const storageEpoch = browserSessionStorageGeneration();
		const clear = () => {
			if (epoch === browserSessionGeneration()) forgetBrowserSession();
		};
		const run = async () => {
			try {
				const response = await network(input, init);
				if (!path.endsWith("/get-session")) return response;
				if (epoch !== browserSessionGeneration()) return Response.json(null);
				if (isSessionRefusal(response)) forgetBrowserSession();
				else if (response.ok) {
					const data = await response.clone().json();
					if (epoch !== browserSessionGeneration()) return Response.json(null);
					if (!data?.needsRefresh) {
						const expiresAt = new Date(data?.session?.expiresAt).getTime();
						if (
							typeof data?.user?.id === "string" &&
							Number.isSafeInteger(expiresAt)
						)
							rememberBrowserSession(
								{ userId: data.user.id, expiresAt },
								epoch,
							);
						else forgetBrowserSession();
					}
				}
				return response;
			} catch (error) {
				if (error instanceof TypeError && navigator.onLine) clear();
				throw error;
			} finally {
				if (signingOut && storageEpoch === browserSessionStorageGeneration()) {
					forgetBrowserSession();
					const signedOutEpoch = browserSessionGeneration();
					void Promise.allSettled([...verifications]).then(() => {
						if (signedOutEpoch === browserSessionGeneration())
							rememberBrowserSession(null);
					});
				}
			}
		};
		const result = run();
		if (path.endsWith("/get-session")) {
			verifications.add(result);
			const settled = () => {
				verifications.delete(result);
			};
			void result.then(settled, settled);
		}
		return result;
	};
}
