import type { Role } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";

// Thunks: the role VALUES stay the persisted enum, only the labels resolve, and
// resolving at module scope would freeze the import-time locale.
export const ROLE_LABELS: Record<Role, () => string> = {
	owner: m.role_label_owner,
	admin: m.role_label_admin,
	member: m.role_label_member,
	viewer: m.role_label_viewer,
};
