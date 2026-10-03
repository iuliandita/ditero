import {
	PUBLIC_API_ID,
	PUBLIC_API_MAX_PAGE_SIZE,
	PUBLIC_API_PAGE_SIZE,
	PublicApiError,
} from "../../domain/public-api.ts";

import type { PublicApiResource } from "../../domain/public-api-resources.ts";

export {
	PUBLIC_API_RESOURCES,
	type PublicApiResource,
} from "../../domain/public-api-resources.ts";
export type PageQuery = {
	limit: number;
	after: string | null;
	workspaceId: string | null;
	listId: string | null;
	done: boolean | null;
};

function invalid(): never {
	throw new PublicApiError(400, "invalid-query", "Invalid query parameters");
}

export function bearerToken(headers: Headers): string | null {
	const authorization = headers.get("authorization");
	return authorization &&
		/^Bearer ditero_pat_[A-Za-z0-9_-]{43}$/i.test(authorization)
		? authorization.slice(7)
		: null;
}

function binding(
	resource: PublicApiResource,
	query: Omit<PageQuery, "after" | "limit">,
): string {
	return JSON.stringify([
		resource,
		query.workspaceId,
		query.listId,
		query.done,
	]);
}

export function encodePageCursor(
	resource: PublicApiResource,
	query: PageQuery,
	id: string,
): string {
	return Buffer.from(
		JSON.stringify([1, binding(resource, query), id]),
	).toString("base64url");
}

export function parsePageQuery(
	url: URL,
	resource: PublicApiResource,
): PageQuery {
	const allowed = new Set([
		"limit",
		"cursor",
		"workspaceId",
		...(resource === "tasks" ? ["listId", "done"] : []),
	]);
	for (const key of url.searchParams.keys()) {
		if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
			invalid();
	}
	const rawLimit = url.searchParams.get("limit");
	if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) invalid();
	const limit = rawLimit === null ? PUBLIC_API_PAGE_SIZE : Number(rawLimit);
	if (limit > PUBLIC_API_MAX_PAGE_SIZE) invalid();
	const workspaceId = url.searchParams.get("workspaceId");
	const listId = url.searchParams.get("listId");
	for (const id of [workspaceId, listId])
		if (id !== null && !PUBLIC_API_ID.safeParse(id).success) invalid();
	const rawDone = url.searchParams.get("done");
	if (rawDone !== null && rawDone !== "true" && rawDone !== "false") invalid();
	const query: PageQuery = {
		limit,
		after: null,
		workspaceId,
		listId,
		done: rawDone === null ? null : rawDone === "true",
	};
	const cursor = url.searchParams.get("cursor");
	if (cursor !== null) {
		if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) invalid();
		try {
			const decoded = Buffer.from(cursor, "base64url");
			if (decoded.toString("base64url") !== cursor) invalid();
			const value: unknown = JSON.parse(decoded.toString("utf8"));
			if (
				!Array.isArray(value) ||
				value.length !== 3 ||
				value[0] !== 1 ||
				value[1] !== binding(resource, query) ||
				!PUBLIC_API_ID.safeParse(value[2]).success
			)
				invalid();
			query.after = value[2];
		} catch {
			invalid();
		}
	}
	return query;
}
