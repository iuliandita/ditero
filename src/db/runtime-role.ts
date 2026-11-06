import type { Pool } from "pg";

type RuntimeRole = {
	role: string;
	superuser: boolean;
	bypassRLS: boolean;
	createRole: boolean;
	replication: boolean;
	memberOfPrivilegedRole: boolean;
	memberOfTableOwner: boolean;
};

export function assertRuntimeRole(role: RuntimeRole): void {
	if (
		role.superuser ||
		role.bypassRLS ||
		role.createRole ||
		role.replication ||
		role.memberOfPrivilegedRole ||
		role.memberOfTableOwner
	) {
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
		create_role: boolean;
		replication: boolean;
		member_of_privileged_role: boolean;
		member_of_table_owner: boolean;
	}>(
		`select current_user as role,
		        role.rolsuper as superuser,
		        role.rolbypassrls as bypass_rls,
		        role.rolcreaterole as create_role,
		        role.rolreplication as replication,
		        exists (
		          select 1 from pg_roles privileged
		          where (privileged.rolsuper or privileged.rolbypassrls
		                 or privileged.rolcreaterole or privileged.rolreplication)
		            and pg_has_role(current_user, privileged.oid, 'MEMBER')
		        ) as member_of_privileged_role,
		        exists (
		          select 1 from pg_class protected_table
		          where (protected_table.relrowsecurity or protected_table.relforcerowsecurity)
		            and pg_has_role(current_user, protected_table.relowner, 'MEMBER')
		        ) as member_of_table_owner
		 from pg_roles role
		 where role.rolname = current_user`,
	);
	const role = result.rows[0];
	if (!role) throw new Error("Unable to inspect the runtime database role");
	assertRuntimeRole({
		role: role.role,
		superuser: role.superuser,
		bypassRLS: role.bypass_rls,
		createRole: role.create_role,
		replication: role.replication,
		memberOfPrivilegedRole: role.member_of_privileged_role,
		memberOfTableOwner: role.member_of_table_owner,
	});
}
