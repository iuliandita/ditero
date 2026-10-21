import type { NoticeCode } from "../../../domain/portability/providers/content-common.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";

const LOCATION = /^(row|card|item|comment|list):(\d+)(?::(.+))?$/;
export function noticeField(code: NoticeCode, path: string): string {
	if (path === "export") return m.import_content_whole_export();
	if (path === "more") return m.import_content_more();
	if (code === "date-order")
		return path === "dmy"
			? m.import_content_date_order_dmy()
			: m.import_content_date_order_mdy();
	const match = LOCATION.exec(path);
	if (!match) return path;
	const kind = {
		row: m.import_content_kind_row,
		card: m.import_content_kind_card,
		item: m.import_content_kind_item,
		comment: m.import_content_kind_comment,
		list: m.import_content_kind_list,
	}[match[1] as "row"]();
	const place = `${kind} ${new Intl.NumberFormat(getLocale()).format(Number(match[2]))}`;
	return match[3] ? `${place}, ${match[3]}` : place;
}

export function contentError(detail: { code?: string; row?: number }): string {
	switch (detail.code) {
		case "invalid-encoding":
			return m.import_content_err_encoding();
		case "invalid-csv":
			return detail.row
				? m.import_content_err_csv_row({
						row: new Intl.NumberFormat(getLocale()).format(detail.row),
					})
				: m.import_content_err_csv();
		case "invalid-json":
			return m.import_content_err_json();
		case "invalid-graph":
			return m.import_content_err_graph();
		case "date-order-required":
			return m.import_content_err_date_order_required();
		case "date-order-conflict":
			return m.import_content_err_date_order_conflict();
		case "timeout":
			return m.import_content_err_timeout();
		default:
			return m.import_content_invalid();
	}
}

export function validZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: zone });
		return zone.trim() === zone && zone.length > 0;
	} catch {
		return false;
	}
}
export const ZONES = (() => {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [] as string[];
	}
})();

// Provider labels are created, not merged: a name that already exists in the target
// workspace blocks the label and its task links, so the preview names them up front.
export function collidingLabelNames(
	imported: { name: string; workspaceId: string }[],
	existing: { name: string; workspaceId: string }[],
	workspaceMap: Record<string, string>,
): string[] {
	return [
		...new Set(
			imported
				.filter((label) =>
					existing.some(
						(row) =>
							row.workspaceId === workspaceMap[label.workspaceId] &&
							row.name === label.name,
					),
				)
				.map((label) => label.name),
		),
	];
}
