export async function mutationServerSucceeded(mutation: {
	server: Promise<{ type: string }>;
}): Promise<boolean> {
	try {
		return (await mutation.server).type === "success";
	} catch {
		return false;
	}
}
