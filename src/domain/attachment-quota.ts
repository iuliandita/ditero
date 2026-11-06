import { z } from "zod";

export const retainedAttachmentQuotaSchema = z.object({
	code: z.literal("quota-retained-deleted"),
	retainedDeletedBytes: z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER),
	restoreWindowEndsAt: z.iso.datetime().nullable(),
	gcPending: z.boolean(),
});

export type RetainedAttachmentQuota = z.infer<
	typeof retainedAttachmentQuotaSchema
>;
