import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { membership, workspace } from "../db/schema.ts";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  databaseHooks: {
    user: {
      create: {
        // New users own a personal workspace and optionally join a shared one.
        after: async (user) => {
          const personalId = crypto.randomUUID();
          await db.insert(workspace).values({
            id: personalId,
            name: `${user.name || user.email}'s space`,
            ownerId: user.id,
            kind: "personal",
          });
          await db.insert(membership).values({
            id: crypto.randomUUID(),
            userId: user.id,
            workspaceId: personalId,
            role: "owner",
          });

          // Dev/e2e convenience: auto-join a shared workspace when configured.
          const defaultId = process.env.DITERO_DEFAULT_WORKSPACE_ID;
          if (!defaultId) return;
          try {
            const exists = await db
              .select({ id: workspace.id })
              .from(workspace)
              .where(eq(workspace.id, defaultId))
              .limit(1);
            if (!exists.length) return;
            const already = await db
              .select({ id: membership.id })
              .from(membership)
              .where(
                and(
                  eq(membership.userId, user.id),
                  eq(membership.workspaceId, defaultId),
                ),
              )
              .limit(1);
            if (already.length) return;
            await db.insert(membership).values({
              id: crypto.randomUUID(),
              userId: user.id,
              workspaceId: defaultId,
              role: "member",
            });
          } catch {
            // Missing/invalid default workspace must not break signup.
          }
        },
      },
    },
  },
  // jwt plugin exposes /api/auth/token and JWKS at /api/auth/jwks.
  plugins: [jwt()],
});
