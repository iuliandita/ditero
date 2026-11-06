import type { Pool } from "pg";

type RuntimeRole = {
	role: string;
	superuser: boolean;
	bypassRLS: boolean;
	createRole: boolean;
	replication: boolean;
	privilegedRoles: string[];
	ownedTables: string[];
	canPruneFocusIntervals: boolean;
};

export function assertRuntimeRole(role: RuntimeRole): void {
	const attributes = [
		role.superuser && "SUPERUSER",
		role.bypassRLS && "BYPASSRLS",
		role.createRole && "CREATEROLE",
		role.replication && "REPLICATION",
	].filter(Boolean);
	if (attributes.length > 0) {
		throw new Error(
			`Runtime database role ${role.role} has forbidden attributes: ${attributes.join(", ")}`,
		);
	}
	if (role.privilegedRoles.length > 0) {
		throw new Error(
			`Runtime database role ${role.role} belongs to privileged roles: ${role.privilegedRoles.join(", ")}`,
		);
	}
	if (role.ownedTables.length > 0) {
		throw new Error(
			`Runtime database role ${role.role} owns or belongs to the owner of RLS tables: ${role.ownedTables.join(", ")}`,
		);
	}
	if (!role.canPruneFocusIntervals) {
		throw new Error(
			`Runtime database role ${role.role} lacks EXECUTE on public.prune_focus_intervals(). Run as the migration owner: GRANT EXECUTE ON FUNCTION public.prune_focus_intervals() TO "${role.role.replaceAll('"', '""')}";`,
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
		privileged_roles: string[];
		owned_tables: string[];
		can_prune_focus_intervals: boolean;
	}>(
		`select current_user as role,
          role.rolsuper as superuser,
          role.rolbypassrls as bypass_rls,
          role.rolcreaterole as create_role,
          role.rolreplication as replication,
          array(
            select format('%I (%s)', privileged.rolname, concat_ws(', ',
              case when privileged.rolsuper then 'SUPERUSER' end,
              case when privileged.rolbypassrls then 'BYPASSRLS' end,
              case when privileged.rolcreaterole then 'CREATEROLE' end,
              case when privileged.rolreplication then 'REPLICATION' end))
            from pg_roles privileged
            where (privileged.rolsuper or privileged.rolbypassrls
                   or privileged.rolcreaterole or privileged.rolreplication)
              and privileged.oid <> role.oid
              and pg_has_role(current_user, privileged.oid, 'MEMBER')
            order by privileged.rolname
          ) as privileged_roles,
          array(
            select format('%I.%I (owner %I)', n.nspname, protected_table.relname,
                          pg_get_userbyid(protected_table.relowner))
            from pg_class protected_table
            join pg_namespace n on n.oid = protected_table.relnamespace
            where (protected_table.relrowsecurity or protected_table.relforcerowsecurity)
              and pg_has_role(current_user, protected_table.relowner, 'MEMBER')
            order by n.nspname, protected_table.relname
          ) as owned_tables,
          has_function_privilege(current_user, 'public.prune_focus_intervals()', 'EXECUTE')
            as can_prune_focus_intervals
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
		privilegedRoles: role.privileged_roles,
		ownedTables: role.owned_tables,
		canPruneFocusIntervals: role.can_prune_focus_intervals,
	});
}
