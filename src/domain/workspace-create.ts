import { z } from "zod";

export const WORKSPACE_NAME_MAX_LENGTH = 100;

function validText(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

export const workspaceNameSchema = z
	.string()
	.refine(validText)
	.transform((value) => value.trim())
	.pipe(z.string().min(1).max(WORKSPACE_NAME_MAX_LENGTH));

export const workspaceCreateSchema = z
	.object({
		id: z.string().uuid(),
		membershipId: z.string().uuid(),
		name: workspaceNameSchema,
	})
	.strict();

export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;
