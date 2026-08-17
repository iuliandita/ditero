// One definition of the membership role ladder, imported by the mutators
// (authorization), ack-complete (delivery gating) and the web client (which
// actions a row may offer).

export const ROLES = ["owner", "admin", "member", "viewer"] as const;

export type Role = (typeof ROLES)[number];

/** May edit content. Viewer is deliberately excluded. */
export const WRITE_ROLES: ReadonlySet<Role> = new Set<Role>([
	"owner",
	"admin",
	"member",
]);

/** May administer the workspace and act on other members' rows. */
export const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(["owner", "admin"]);
