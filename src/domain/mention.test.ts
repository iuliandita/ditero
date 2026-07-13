import { describe, expect, test } from "vitest";
import { parseMentions } from "./mention.ts";

describe("parseMentions", () => {
	test("single mention", () => {
		expect(parseMentions("hey @alice check this")).toEqual(["alice"]);
	});

	test("multiple mentions keep first-seen order", () => {
		expect(parseMentions("@bob and @carol")).toEqual(["bob", "carol"]);
	});

	test("duplicates collapse to one", () => {
		expect(parseMentions("@al @al")).toEqual(["al"]);
	});

	test("email is not a mention (@ preceded by a word char)", () => {
		expect(parseMentions("mail me a@b.com")).toEqual([]);
	});

	test("standalone @ yields nothing", () => {
		expect(parseMentions("@")).toEqual([]);
		expect(parseMentions("say @ now")).toEqual([]);
	});

	test("trailing punctuation bounds the handle", () => {
		expect(parseMentions("@dana!")).toEqual(["dana"]);
		expect(parseMentions("(@erin)")).toEqual(["erin"]);
	});

	test("empty string yields nothing", () => {
		expect(parseMentions("")).toEqual([]);
	});

	test("handle charset covers letters, digits, dot, underscore, hyphen", () => {
		expect(parseMentions("@a.b_c-9 done")).toEqual(["a.b_c-9"]);
	});

	test("mention at start of string", () => {
		expect(parseMentions("@zed rules")).toEqual(["zed"]);
	});

	test("mid-word @ is ignored", () => {
		expect(parseMentions("foo@bar")).toEqual([]);
	});

	test("case preserved, dedup is exact", () => {
		expect(parseMentions("@Al @al")).toEqual(["Al", "al"]);
	});

	test("never throws on odd input", () => {
		expect(() => parseMentions("@@@ @. @- @_x")).not.toThrow();
	});
});
