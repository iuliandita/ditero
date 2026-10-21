export function webCryptoAvailable(): boolean {
	return (
		globalThis.isSecureContext === true && Boolean(globalThis.crypto?.subtle)
	);
}

export function passkeysAvailable(operation: "get" | "create"): boolean {
	return (
		globalThis.isSecureContext === true &&
		typeof globalThis.PublicKeyCredential !== "undefined" &&
		typeof globalThis.navigator?.credentials?.[operation] === "function"
	);
}
