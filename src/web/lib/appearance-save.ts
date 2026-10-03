import { mutationServerSucceeded } from "./pref-mutation.ts";

export type AppearanceMutation = {
	client: Promise<{ type: string }>;
	server: Promise<{ type: string }>;
};

export async function appearanceSaveSucceeded(
	mutation: AppearanceMutation,
	onAccepted: () => void,
): Promise<boolean> {
	// Accepted offline writes still belong to Zero's durable retirement barrier.
	const persisted = mutationServerSucceeded(mutation);
	try {
		if ((await mutation.client).type !== "success") return false;
		onAccepted();
		return await persisted;
	} catch {
		return false;
	}
}
