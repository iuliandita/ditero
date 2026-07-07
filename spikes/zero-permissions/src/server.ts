// Spike API: hosts Zero's synced-query endpoint (read-permission enforcement)
// + a dev /token route to mint a JWT for a given user. Mutate endpoint added
// once reads are proven.
import { cors } from "@elysiajs/cors";
import { mustGetQuery } from "@rocicorp/zero";
import { handleQueryRequest } from "@rocicorp/zero/server";
import { Elysia } from "elysia";
import { mintToken, verifyToken } from "./auth.ts";
import { ackReminder } from "./notify/engine.ts";
import { queries } from "./zero/queries.ts";
import { schema } from "./zero/schema.gen.ts";

const PORT = Number(process.env.API_PORT ?? 3000);

const app = new Elysia()
  .use(cors())
  .get("/health", () => ({ ok: true }))
  // Dev convenience: mint a token for a user id (spike only).
  .get("/token/:userId", ({ params }) => mintToken(params.userId))
  // Zero synced-query endpoint. zero-cache POSTs here; we authenticate and
  // return filtered queries so only permitted rows sync.
  .post("/api/zero/query", async ({ request }) => {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const ctx = token ? await verifyToken(token) : undefined;
    const result = await handleQueryRequest({
      handler: (name: string, args: unknown) => {
        const q = mustGetQuery(queries, name);
        // Deny by default: no/invalid token -> a ctx id that matches no rows.
        return q.fn({ args: args as never, ctx: ctx ?? { id: "__nobody__" } });
      },
      schema,
      request,
      userID: ctx?.id,
    });
    return result instanceof Response ? result : Response.json(result);
  })
  // Ack webhook. ntfy http action = POST; telegram url button = GET.
  .post("/ack/:reminderId", async ({ params, query }) => {
    await ackReminder(params.reminderId, String((query as { user?: string }).user ?? ""));
    return { ok: true };
  })
  .get("/ack/:reminderId", async ({ params, query }) => {
    await ackReminder(params.reminderId, String((query as { user?: string }).user ?? ""));
    return "Acked. You can close this.";
  })
  .listen(PORT);

console.log(`spike api on :${PORT}`);

export type App = typeof app;
