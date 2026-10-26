import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp, context } from "../core/app";
import type { Sql } from "../core/store";

const dbPath = process.env.DINGHY_DB ?? "./data/dinghy.db";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

const sql: Sql = {
  async all(q, ...p) {
    return db.query(q).all(...(p as never[])) as never;
  },
  async run(q, ...p) {
    return { changes: db.query(q).run(...(p as never[])).changes };
  },
  async exec(q) {
    db.exec(q);
  },
};

const ctx = context(process.env, sql);
const app = buildApp(async () => ctx, {
  name: "bun",
  defer: (p) => void p,
});

const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 30 });
console.log(`[dinghy] listening on :${port} (db ${dbPath})`);

if ("error" in ctx) {
  console.warn(`[dinghy] not configured: ${ctx.error}`);
} else {
  await ctx.store.init();
  const every = Number(process.env.DINGHY_RECONCILE_SECONDS ?? 20) * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ctx.orch.reconcile();
    } catch (e) {
      console.error("[dinghy] reconcile", e);
    } finally {
      running = false;
    }
  };
  setInterval(tick, every);
  void tick();
}
