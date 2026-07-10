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
		},
		task: { id: true, listId: true, title: true, done: true },
	},
});
