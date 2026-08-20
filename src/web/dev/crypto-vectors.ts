// Dev/test-only bridge from the browser to the pure crypto layer. Every vector
// in src/domain/e2e/*.test.ts runs under Bun, which is not the runtime that
// holds a user's keys: tests/e2e/crypto-vectors.spec.ts re-runs them in
// Chromium, Firefox and WebKit through this handle.
//
// Shipping it would hand any page script a signing/unwrapping oracle over the
// user's key material, so the whole body -- including the dynamic imports, so
// the modules themselves are not even reachable -- is behind a guard on two
// compile-time constants that vite replaces with literals. Its absence from a
// production build is asserted in crypto-vectors.test.ts.

type CryptoHarness = {
	hpke: typeof import("../../domain/e2e/hpke.ts");
	kdf: typeof import("../../domain/e2e/kdf.ts");
	envelope: typeof import("../../domain/e2e/envelope.ts");
	stream: typeof import("../../domain/e2e/stream.ts");
	wdkCommitment: typeof import("../../domain/e2e/wdk-commitment.ts");
	recoveryCode: typeof import("../../domain/e2e/recovery-code.ts");
};

declare global {
	interface Window {
		__diteroCrypto?: CryptoHarness;
	}
}

export function installCryptoVectorHarness(): void {
	// `import.meta.env.DEV` is `false` and `MODE` is `"production"` in a
	// production build, so this narrows to a bare `return` and everything below
	// is dropped by the bundler.
	if (!import.meta.env.DEV && import.meta.env.MODE !== "test") return;
	void (async () => {
		const [hpke, kdf, envelope, stream, wdkCommitment, recoveryCode] =
			await Promise.all([
				import("../../domain/e2e/hpke.ts"),
				import("../../domain/e2e/kdf.ts"),
				import("../../domain/e2e/envelope.ts"),
				import("../../domain/e2e/stream.ts"),
				import("../../domain/e2e/wdk-commitment.ts"),
				import("../../domain/e2e/recovery-code.ts"),
			]);
		// Assigned last and in one write: the spec waits on this property, so a
		// partially populated handle would race rather than fail.
		window.__diteroCrypto = {
			hpke,
			kdf,
			envelope,
			stream,
			wdkCommitment,
			recoveryCode,
		};
	})();
}
