import { drizzleZeroConfig } from "drizzle-zero";
import * as schema from "./src/db/schema.ts";

export default drizzleZeroConfig(schema, {
	tables: {
		user: { id: true, name: true, image: true },
		workspace: { id: true, name: true, ownerId: true, kind: true },
		membership: { id: true, userId: true, workspaceId: true, role: true },
		list: {
			id: true,
			workspaceId: true,
			ownerId: true,
			title: true,
			kind: true,
			icon: true,
			folderId: true,
			sortKey: true,
			completedDisplay: true,
		},
		task: {
			id: true,
			listId: true,
			title: true,
			done: true,
			notes: true,
			dueAt: true,
			dueAllDay: true,
			priority: true,
			completedAt: true,
			sortKey: true,
			parentId: true,
			quantity: true,
			unit: true,
			category: true,
		},
		folder: { id: true, workspaceId: true, name: true, sortKey: true },
		label: { id: true, workspaceId: true, name: true, color: true },
		taskLabel: { id: true, taskId: true, labelId: true },
		template: {
			id: true,
			workspaceId: true,
			kind: true,
			name: true,
			icon: true,
			content: true,
			createdBy: true,
		},
	},
});
