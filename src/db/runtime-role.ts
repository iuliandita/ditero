import type { Pool } from "pg";

type RuntimeRole = {
	role: string;
	superuser: boolean;
	bypassRLS: boolean;
	memberOfTableOwner: boolean;
};

export function assertRuntimeRole(role: RuntimeRole): void {
	if (role.superuser || role.bypassRLS || role.memberOfTableOwner) {
		throw new Error(
			`Runtime database role ${role.role} can bypass row-level security`,
		);
	}
}

export async function verifyRuntimeDatabaseRole(pool: Pool): Promise<void> {
	const result = await pool.query<{
		role: string;
		superuser: boolean;
		bypass_rls: boolean;
		member_of_table_owner: boolean;
	}>(
		`select current_user as role,
		        role.rolsuper as superuser,
		        role.rolbypassrls as bypass_rls,
		        pg_has_role(current_user, table_owner.rolname, 'MEMBER') as member_of_table_owner
		 from pg_roles role
		 join pg_class secret_table on secret_table.oid = 'user_secret'::regclass
		 join pg_roles table_owner on table_owner.oid = secret_table.relowner
		 where role.rolname = current_user`,
	);
	const role = result.rows[0];
	if (!role) throw new Error("Unable to inspect the runtime database role");
	assertRuntimeRole({
		role: role.role,
		superuser: role.superuser,
		bypassRLS: role.bypass_rls,
		memberOfTableOwner: role.member_of_table_owner,
	});
}
