import { z } from "zod";
import { panelsSchema } from "./dashboard.ts";
import { PUBLIC_API_ID } from "./public-api.ts";
import { filterGroupSchema, viewDisplaySchema } from "./view-filter.ts";

export const PUBLIC_API_RESOURCES = [
	"workspaces",
	"lists",
	"tasks",
	"people",
	"labels",
	"views",
	"dashboards",
	"folders",
] as const;
export type PublicApiResource = (typeof PUBLIC_API_RESOURCES)[number];
const nullableText = z.string().nullable();
const nullableInstant = z.iso.datetime().nullable();
const scope = z.enum(["personal", "workspace"]);
const savedSurface = {
	id: PUBLIC_API_ID,
	ownerId: PUBLIC_API_ID,
	workspaceId: PUBLIC_API_ID.nullable(),
	scope,
	name: z.string(),
	icon: nullableText,
};

export const publicApiProfileSchema = z
	.object({
		id: PUBLIC_API_ID,
		name: z.string(),
		timezone: z.string(),
		timezoneChosen: z.boolean(),
		locale: z.string(),
		serverTime: z.iso.datetime(),
		tokenAccess: z.enum(["read", "write"]),
	})
	.strict();

export const publicApiResourceSchemas = {
	workspaces: z
		.object({
			id: PUBLIC_API_ID,
			name: z.string(),
			kind: z.enum(["personal", "shared"]),
			ownerId: PUBLIC_API_ID,
			role: z.enum(["owner", "admin", "member", "viewer"]),
		})
		.strict(),
	lists: z
		.object({
			id: PUBLIC_API_ID,
			workspaceId: PUBLIC_API_ID,
			ownerId: PUBLIC_API_ID,
			title: z.string(),
			kind: z.enum(["tasks", "shopping", "checklist", "project", "habits"]),
			icon: nullableText,
			folderId: PUBLIC_API_ID.nullable(),
			sortKey: z.string(),
			completedDisplay: z.enum(["sink", "keep", "hide"]),
		})
		.strict(),
	tasks: z
		.object({
			id: PUBLIC_API_ID,
			listId: PUBLIC_API_ID,
			workspaceId: PUBLIC_API_ID,
			title: z.string(),
			done: z.boolean(),
			notes: nullableText,
			dueAt: nullableInstant,
			dueAllDay: z.boolean(),
			priority: z.number().int(),
			completedAt: nullableInstant,
			createdAt: nullableInstant,
			sortKey: z.string(),
			parentId: PUBLIC_API_ID.nullable(),
			quantity: nullableText,
			unit: nullableText,
			category: nullableText,
			rrule: nullableText,
			recurrenceRelative: z.boolean(),
			reminderTime: nullableText,
			assigneeIds: z.array(PUBLIC_API_ID),
			labelIds: z.array(PUBLIC_API_ID),
		})
		.strict(),
	people: z
		.object({
			id: PUBLIC_API_ID,
			name: z.string(),
			image: nullableText,
			workspaceIds: z.array(PUBLIC_API_ID),
		})
		.strict(),
	labels: z
		.object({
			id: PUBLIC_API_ID,
			workspaceId: PUBLIC_API_ID,
			name: z.string(),
			color: z.string(),
		})
		.strict(),
	views: z
		.object({
			...savedSurface,
			filter: filterGroupSchema,
			display: viewDisplaySchema,
		})
		.strict(),
	dashboards: z.object({ ...savedSurface, panels: panelsSchema }).strict(),
	folders: z
		.object({
			id: PUBLIC_API_ID,
			workspaceId: PUBLIC_API_ID,
			name: z.string(),
			sortKey: z.string(),
		})
		.strict(),
};

export type ApiWorkspace = z.infer<typeof publicApiResourceSchemas.workspaces>;
export type ApiList = z.infer<typeof publicApiResourceSchemas.lists>;
export type ApiTask = z.infer<typeof publicApiResourceSchemas.tasks>;
export type ApiPerson = z.infer<typeof publicApiResourceSchemas.people>;
export type ApiView = z.infer<typeof publicApiResourceSchemas.views>;
export type ApiDashboard = z.infer<typeof publicApiResourceSchemas.dashboards>;

export type ApiFolder = z.infer<typeof publicApiResourceSchemas.folders>;
