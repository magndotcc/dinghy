import { type Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Child } from "hono/jsx";
import { type Config, ConfigError, type Env, loadConfig } from "./config";
import { verifyWebhook } from "./github";
import { type BakeState, Orchestrator, type WorkflowJobEvent } from "./orchestrator";
import { GITHUB_HOSTED_PER_MIN, HOURLY_USD, SPECS, type MachineSize } from "./pricing";
import { type Sql, Store, now } from "./store";

export interface Platform {
  /** Keeps work alive after the response is sent (waitUntil on Workers, fire-and-forget on Bun). */
  defer(p: Promise<unknown>, c: Context): void;
  name: "bun" | "cloudflare";
}

export interface Ctx {
  cfg: Config;
  orch: Orchestrator;
  store: Store;
}

/** One orchestrator per (env, sql) pair, built lazily so a bad config shows a setup page instead of crashing. */
export function context(env: Env, sql: Sql): Ctx | { error: string } {
  try {
    const cfg = loadConfig(env);
    const store = new Store(sql);
    return { cfg, store, orch: new Orchestrator(cfg, store) };
  } catch (e) {
    if (e instanceof ConfigError) return { error: e.message };
    throw e;
  }
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const ago = (t: number | null) => {
  if (!t) return "—";
  const s = now() - t;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const dur = (a: number | null, b: number | null) => {
  if (!a) return "—";
  const s = (b ?? now()) - a;
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const CSS = `
:root{--bg:#0b0d12;--fg:#e6e8ee;--mute:#8a90a2;--line:#1e2230;--card:#11141c;--acc:#3b5bdb;--ok:#2f9e44;--bad:#e03131;--warn:#f59f00}
@media (prefers-color-scheme: light){:root{--bg:#f7f8fb;--fg:#11141c;--mute:#5c6275;--line:#e3e6ee;--card:#fff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:28px 20px 60px}a{color:var(--acc)}
header{display:flex;align-items:center;gap:12px;margin-bottom:24px}header h1{font-size:20px;margin:0}header .tag{color:var(--mute)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.card .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:24px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:500;font-size:12px}
td.num{font-variant-numeric:tabular-nums;text-align:right}tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.s-running,.s-busy{color:var(--acc)}.s-completed.c-success,.s-done{color:var(--ok)}.s-failed,.c-failure{color:var(--bad)}.s-queued,.s-provisioning,.s-idle{color:var(--warn)}
h2{font-size:15px;margin:28px 0 10px}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}
.mute{color:var(--mute)}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.scroll{overflow-x:auto}
`;

function Page(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%233b5bdb'/><path d='M14 42h36l-6 8H20z' fill='white'/><path d='M32 12v26H18z' fill='white'/><path d='M35 18v20h12z' fill='white' opacity='.8'/></svg>" />
        <style>{CSS}</style>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

function Header(props: { sub?: string }) {
  return (
    <header>
      <h1>⛵ dinghy</h1>
      <span class="tag">{props.sub ?? "ephemeral GitHub Actions runners on boat.dev"}</span>
    </header>
  );
}

function SetupPage(props: { error: string; url: string }) {
  return (
    <Page title="dinghy · setup">
      <Header sub="setup needed" />
      <div class="card">
        <p>
          <b>dinghy is running but is not configured yet.</b>
        </p>
        <pre>{props.error}</pre>
        <p class="mute">
          Set the variables, restart, and point a GitHub webhook (event: <code>Workflow jobs</code>) at{" "}
          <code>{props.url}/webhook</code>. See the README.
        </p>
      </div>
    </Page>
  );
}

export function buildApp(getCtx: (c: { env: unknown }) => Promise<Ctx | { error: string }>, platform: Platform) {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();

  app.get("/healthz", (c) => c.json({ ok: true, platform: platform.name }));

  app.use("*", async (c, next) => {
    const ctx = await getCtx(c);
    if ("error" in ctx) {
      if (c.req.path === "/webhook") return c.json({ ok: false, error: ctx.error }, 503);
      return c.html(<SetupPage error={ctx.error} url={new URL(c.req.url).origin} />, 503);
    }
    await ctx.store.init();
    c.set("ctx", ctx);
    await next();
  });

  app.post("/webhook", async (c) => {
    const { cfg, orch } = c.get("ctx");
    const body = await c.req.text();
    if (!(await verifyWebhook(cfg.github.webhookSecret, body, c.req.header("x-hub-signature-256")))) {
      return c.json({ ok: false, error: "bad signature" }, 401);
    }
    const event = c.req.header("x-github-event");
    if (event === "ping") return c.json({ ok: true, pong: true });
    if (event !== "workflow_job") return c.json({ ok: true, ignored: event });
    const payload = JSON.parse(body) as WorkflowJobEvent;
    // Record the job synchronously so a redelivery is deduped, then let provisioning run past the response:
    // GitHub times out webhooks after 10 s.
    const work = orch.onWorkflowJob(payload);
    platform.defer(work.catch((e) => console.error("[dinghy] webhook", e)), c);
    const result = await Promise.race([work, new Promise<string>((r) => setTimeout(() => r("accepted"), 8000))]).catch(
      (e: Error) => `error: ${e.message}`,
    );
    return c.json({ ok: true, result });
  });

  // Everything below is the operator surface.
  app.use("*", async (c, next) => {
    const { cfg } = c.get("ctx");
    if (!cfg.adminPassword) {
      return c.html(
        <Page title="dinghy">
          <Header />
          <div class="card">
            Set <code>DINGHY_ADMIN_PASSWORD</code> to enable the dashboard. The webhook at <code>/webhook</code> works without it.
          </div>
        </Page>,
        403,
      );
    }
    return basicAuth({ username: "admin", password: cfg.adminPassword })(c, next);
  });

  app.get("/api/status", async (c) => {
    const { store, orch } = c.get("ctx");
    return c.json({
      active: await store.activeRunnerCount(),
      queued: (await store.jobsByStatus("queued")).length,
      snapshot: await orch.snapshotName(),
      bake: await store.getKv<BakeState>("bake"),
      runners: await store.recentRunners(50),
      jobs: await store.recentJobs(50),
    });
  });

  app.get("/api/usage", async (c) => {
    const { store, cfg } = c.get("ctx");
    const from = Number(c.req.query("from") ?? now() - 30 * 86400);
    const to = Number(c.req.query("to") ?? now() + 1);
    const rows = await store.usage(from, to);
    const k = 1 + cfg.billing.markupPercent / 100;
    return c.json({
      from,
      to,
      markupPercent: cfg.billing.markupPercent,
      currency: cfg.billing.currency,
      owners: rows.map((r) => ({ ...r, cost_usd: Number(r.cost_usd), price: Number(r.cost_usd) * k })),
    });
  });

  app.post("/api/reconcile", async (c) => c.json(await c.get("ctx").orch.reconcile()));
  app.post("/api/bake", async (c) => c.json(await c.get("ctx").orch.startBake()));

  app.post("/bake", async (c) => {
    await c.get("ctx").orch.startBake();
    return c.redirect("/");
  });

  app.get("/", async (c) => {
    const { store, orch, cfg } = c.get("ctx");
    const [runners, jobs, active, queued, bake, snapshot, usage] = await Promise.all([
      store.recentRunners(30),
      store.recentJobs(30),
      store.activeRunnerCount(),
      store.jobsByStatus("queued"),
      store.getKv<BakeState>("bake"),
      orch.snapshotName(),
      store.usage(now() - 30 * 86400, now() + 1),
    ]);
    const spend = usage.reduce((a, r) => a + Number(r.cost_usd), 0);
    const seconds = usage.reduce((a, r) => a + Number(r.seconds), 0);
    const ghEquivalent = await store.sql.all<{ size: string; s: number }>(
      "SELECT size, SUM(COALESCE(finished_at, ?) - COALESCE(busy_at, created_at)) AS s FROM runners WHERE created_at >= ? AND job_id IS NOT NULL GROUP BY size",
      now(),
      now() - 30 * 86400,
    );
    const ghCost = ghEquivalent.reduce((a, r) => a + Math.ceil(Number(r.s) / 60) * GITHUB_HOSTED_PER_MIN[r.size as MachineSize], 0);
    const k = 1 + cfg.billing.markupPercent / 100;
    const origin = cfg.publicUrl ?? new URL(c.req.url).origin;

    return c.html(
      <Page title="dinghy">
        <Header sub={`instance “${cfg.instance}” · label “${cfg.runners.label}” · on ${platform.name}`} />
        <div class="grid">
          <div class="card"><div class="k">Active runners</div><div class="v">{active} / {cfg.runners.maxConcurrent}</div></div>
          <div class="card"><div class="k">Queued jobs</div><div class="v">{queued.length}</div></div>
          <div class="card"><div class="k">boat spend · 30d</div><div class="v">{usd(spend)}</div></div>
          <div class="card"><div class="k">GitHub-hosted equiv.</div><div class="v">{usd(ghCost)}</div></div>
          <div class="card"><div class="k">VM time · 30d</div><div class="v">{(seconds / 3600).toFixed(1)}h</div></div>
        </div>

        <h2>Snapshot</h2>
        <div class="card row">
          {snapshot ? (
            <span>Runners boot from saved snapshot <code>{snapshot}</code>.</span>
          ) : (
            <span class="mute">No snapshot yet: each runner installs the Actions runner on boot (~30–60 s). Bake one for &lt;5 s starts.</span>
          )}
          {bake && bake.status !== "ready" && (
            <span class={`pill s-${bake.status === "failed" ? "failed" : "provisioning"}`}>bake {bake.status}{bake.error ? `: ${bake.error}` : ""}</span>
          )}
          {!cfg.runners.snapshot && (
            <form method="post" action="/bake"><button type="submit">{snapshot ? "Re-bake snapshot" : "Bake snapshot"}</button></form>
          )}
        </div>

        <h2>Runners</h2>
        <div class="scroll">
          <table>
            <thead><tr><th>Runner</th><th>Repo</th><th>Size</th><th>Status</th><th>Sandbox</th><th>Started</th><th>Lifetime</th><th class="num">Cost</th></tr></thead>
            <tbody>
              {runners.length === 0 && <tr><td colspan={8} class="mute">No runners yet.</td></tr>}
              {runners.map((r) => (
                <tr>
                  <td><code>{r.name}</code></td>
                  <td>{r.repo}</td>
                  <td>{r.size}</td>
                  <td><span class={`pill s-${r.status}`} title={r.error ?? ""}>{r.status}</span></td>
                  <td><code class="mute">{r.sandbox_id ?? "—"}</code></td>
                  <td>{ago(r.created_at)}</td>
                  <td>{dur(r.created_at, r.finished_at)}</td>
                  <td class="num">{r.cost_usd != null ? usd(r.cost_usd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Jobs</h2>
        <div class="scroll">
          <table>
            <thead><tr><th>Job</th><th>Repo</th><th>Workflow</th><th>Status</th><th>Queued</th><th>Wait</th><th>Duration</th></tr></thead>
            <tbody>
              {jobs.length === 0 && <tr><td colspan={7} class="mute">No jobs yet. Add <code>runs-on: [self-hosted, {cfg.runners.label}]</code> to a workflow.</td></tr>}
              {jobs.map((j) => (
                <tr>
                  <td>{j.html_url ? <a href={j.html_url}>{j.name ?? j.id}</a> : (j.name ?? j.id)}</td>
                  <td>{j.repo}</td>
                  <td>{j.workflow ?? "—"}</td>
                  <td><span class={`pill s-${j.status} c-${j.conclusion ?? ""}`}>{j.conclusion ?? j.status}</span></td>
                  <td>{ago(j.queued_at)}</td>
                  <td>{dur(j.queued_at, j.started_at ?? j.finished_at)}</td>
                  <td>{j.started_at ? dur(j.started_at, j.finished_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Usage by owner · 30d {cfg.billing.markupPercent ? `· +${cfg.billing.markupPercent}% markup` : ""}</h2>
        <table>
          <thead><tr><th>Owner</th><th class="num">Runners</th><th class="num">VM hours</th><th class="num">boat cost</th><th class="num">Billable</th></tr></thead>
          <tbody>
            {usage.length === 0 && <tr><td colspan={5} class="mute">Nothing yet.</td></tr>}
            {usage.map((u) => (
              <tr>
                <td>{u.owner}</td>
                <td class="num">{u.runners}</td>
                <td class="num">{(Number(u.seconds) / 3600).toFixed(2)}</td>
                <td class="num">{usd(Number(u.cost_usd))}</td>
                <td class="num">{usd(Number(u.cost_usd) * k)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Use it</h2>
        <pre>{`# GitHub → Settings → Webhooks → Add webhook
Payload URL:  ${origin}/webhook
Content type: application/json
Secret:       $GITHUB_WEBHOOK_SECRET
Events:       Workflow jobs

# .github/workflows/ci.yml
jobs:
  test:
    runs-on: [self-hosted, ${cfg.runners.label}]          # ${cfg.runners.defaultSize}: ${SPECS[cfg.runners.defaultSize]}
  big:
    runs-on: [self-hosted, ${cfg.runners.label}-large]    # large: ${SPECS.large}`}</pre>
        <p class="mute">
          Prices: {(Object.keys(HOURLY_USD) as MachineSize[]).map((s) => `${s} $${HOURLY_USD[s]}/h`).join(" · ")}, billed per second by boat.
        </p>
      </Page>,
    );
  });

  return app;
}
