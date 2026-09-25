import { expect, test } from "vitest";
import {
	type ActivationQuery,
	reconcileActiveTaskRecipients,
} from "../../src/zero/task-activation-transition.ts";

test("oversized pair bytes stop before assignment rows are materialized", async () => {
	const sqlSeen: string[] = [];
	const query: ActivationQuery = async (sql) => {
		sqlSeen.push(sql);
		if (sql.includes("from task t join list l"))
			return [
				{ id: "task", due_at: null, workspace_id: "ws", owner_id: "alice" },
			];
		if (sql.includes("count(*)") && sql.includes("from task_assignee"))
			return [{ count: "1", bytes: String(64 * 1024 * 1024 + 1) }];
		throw new Error("Unexpected materialization query");
	};
	await expect(
		reconcileActiveTaskRecipients(query, "task", {
			userIds: ["alice"],
			workspaceIds: ["ws"],
			evidence: { rows: 0, bytes: 0 },
		}),
	).rejects.toThrow(/evidence exceeds import limit/);
	expect(sqlSeen).toHaveLength(2);
});
