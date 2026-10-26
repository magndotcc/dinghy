import { buildApp, context, type Ctx } from "../core/app";
import type { Env } from "../core/config";
import type { Sql } from "../core/store";

type Bindings = Env & { DB: D1Database };

function d1(db: D1Database): Sql {
  return {
    async all(q, ...p) {
      return (await db.prepare(q).bind(...p).all()).results as never;
    },
    async run(q, ...p) {
      const r = await db.prepare(q).bind(...p).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async exec(q) {
      // D1's exec() is line-oriented; batch the statements instead.
      const stmts = q.split(";").map((s) => s.trim()).filter(Boolean);
      await db.batch(stmts.map((s) => db.prepare(s)));
    },
  };
}

// Reused across requests within an isolate so GitHub App tokens stay cached.
let cached: { env: Bindings; ctx: Ctx | { error: string } } | null = null;
function ctxFor(env: Bindings) {
  if (cached?.env !== env) cached = { env, ctx: context(env as Env, d1(env.DB)) };
  return cached.ctx;
}

const app = buildApp(async (c) => ctxFor(c.env as Bindings), {
  name: "cloudflare",
  defer: (p, c) => c.executionCtx.waitUntil(p),
});

export default {
  fetch: (req: Request, env: Bindings, ec: ExecutionContext) => app.fetch(req, env, ec),
  async scheduled(_: ScheduledController, env: Bindings, ec: ExecutionContext) {
    const ctx = ctxFor(env);
    if ("error" in ctx) return;
    ec.waitUntil(ctx.store.init().then(() => ctx.orch.reconcile()));
  },
} satisfies ExportedHandler<Bindings>;
