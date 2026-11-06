import type { RetainedAttachmentQuota } from "../../../domain/attachment-quota.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { formatBytes } from "../intl-format.ts";

export function attachmentQuotaMessage(quota: RetainedAttachmentQuota): string {
	const bytes = formatBytes(quota.retainedDeletedBytes);
	if (quota.gcPending || quota.restoreWindowEndsAt === null)
		return m.attachment_quota_cleanup_pending({ bytes });
	const date = new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(quota.restoreWindowEndsAt));
	return m.attachment_quota_retained_deleted({ bytes, date });
}
