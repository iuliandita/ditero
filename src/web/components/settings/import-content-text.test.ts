import { describe, expect, test } from "vitest";
import { m } from "../../../paraglide/messages.js";
import {
	collidingLabelNames,
	contentError,
	noticeField,
	validZone,
} from "./import-content-text.ts";

describe("import content text", () => {
	test.each([
		["invalid-encoding", m.import_content_err_encoding()],
		["invalid-csv", m.import_content_err_csv()],
		["invalid-json", m.import_content_err_json()],
		["invalid-graph", m.import_content_err_graph()],
		["date-order-required", m.import_content_err_date_order_required()],
		["date-order-conflict", m.import_content_err_date_order_conflict()],
		["timeout", m.import_content_err_timeout()],
		["invalid-row", m.import_content_invalid()],
	])("a %s failure shows its own message", (code, message) => {
		expect(contentError({ code })).toBe(message);
	});
	test("a CSV failure names the row", () => {
		expect(contentError({ code: "invalid-csv", row: 12 })).toBe(
			m.import_content_err_csv_row({ row: "12" }),
		);
	});
	test.each([
		["row:12:Title", `${m.import_content_kind_row()} 12, Title`],
		["card:3", `${m.import_content_kind_card()} 3`],
		["more", m.import_content_more()],
		["export", m.import_content_whole_export()],
		["Order", "Order"],
	])("path %s is localized", (path, text) => {
		expect(noticeField("row-skipped", path)).toBe(text);
	});
	test("the chosen date order is named, not shown as a code", () => {
		expect(noticeField("date-order", "dmy")).toBe(
			m.import_content_date_order_dmy(),
		);
	});
	test.each([
		["Europe/Berlin", true],
		["UTC", true],
		["Mars/Base", false],
		["", false],
		[" Europe/Berlin", false],
	])("time zone %j validity is %s", (zone, valid) => {
		expect(validZone(zone)).toBe(valid);
	});
	test("labels that already exist in the chosen target workspace are named once", () => {
		expect(
			collidingLabelNames(
				[
					{ name: "home", workspaceId: "src" },
					{ name: "home", workspaceId: "src" },
					{ name: "new", workspaceId: "src" },
				],
				[
					{ name: "home", workspaceId: "target" },
					{ name: "new", workspaceId: "other" },
				],
				{ src: "target" },
			),
		).toEqual(["home"]);
	});
});
