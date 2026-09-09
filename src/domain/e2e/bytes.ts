// WebCrypto rejects a SharedArrayBuffer-backed view, and the DOM types say so;
// this narrows to that contract without copying, so byteOffset is preserved.
// Passing `.buffer` instead of the view would hand the whole backing store to
// the primitive. Deliberately `instanceof ArrayBuffer` and NOT `!(x instanceof
// SharedArrayBuffer)`: a cross-realm ArrayBuffer fails this check, which costs
// a caller one copy, whereas the inverted form passes anything unrecognised
// straight through. Same check, and only this direction fails safe.
//
// Returned as a per-module closure rather than taking the tag as an argument,
// so every call site stays `bytes(x)` and each module keeps its own error
// prefix.
export function byteNarrower(
	tag: string,
): (view: Uint8Array) => Uint8Array<ArrayBuffer> {
	return (view) => {
		if (!(view.buffer instanceof ArrayBuffer)) {
			throw new Error(`${tag}: byte views must not be shared-memory backed`);
		}
		return view as Uint8Array<ArrayBuffer>;
	};
}
