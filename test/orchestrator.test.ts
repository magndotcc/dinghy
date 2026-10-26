import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { buildApp, type Ctx } from "../src/core/app";
import { Boat, type Sandbox } from "../src/core/boat";
import { loadConfig } from "../src/core/config";
import { GitHub } from "../src/core/github";
import { matchJob } from "../src/core/labels";
import { Orchestrator, type WorkflowJobEvent } from "../src/core/orchestrator";
import { type Sql, Store } from "../src/core/store";

function memSql(): Sql {
  const db = new Database(":memory:");
  return {
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
}

/** In-memory boat.dev + GitHub that record calls. */
function fakes() {
  const sandboxes = new Map<string, Sandbox & { body: any }>();
  const runners = new Map<number, { name: string; busy: boolean }>();
  const calls: string[] = [];
  const jobs = new Map<number, { status: string; conclusion: string | null; runner_name: string | null }>();
  let n = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  const boatFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/api/v1", "");
    const method = init.method ?? "GET";
    calls.push(`boat ${method} ${path}`);
    if (method === "POST" && path === "/sandboxes") {
      const body = JSON.parse(String(init.body));
      const id = `bx_${String(++n).padStart(8, "a")}`;
      const sb = { id, name: body.name, state: "provisioning" as const, setupStatus: "pending" as const, body };
      sandboxes.set(id, sb);
      return json({ ok: true, sandbox: sb }, 202);
    }
    if (method === "GET" && path === "/sandboxes") return json({ ok: true, sandboxes: [...sandboxes.values()], pageInfo: { hasMore: false } });
    const m = path.match(/^\/sandboxes\/(bx_\w+)$/);
    if (m) {
      const sb = sandboxes.get(m[1]!);
      if (!sb) return json({ ok: false, code: "not_found", message: "nope" }, 404);
      if (method === "GET") return json({ ok: true, sandbox: sb });
      if (method === "DELETE") {
        expect((init.headers as Record<string, string>)["X-Ascii-Confirm-Delete"]).toBe(m[1]);
        sandboxes.delete(m[1]!);
        return json({ ok: true }, 202);
      }
    }
    return json({ ok: false, code: "unhandled", message: path }, 500);
  });

  const ghFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`gh ${method} ${u.pathname}`);
    if (u.pathname.endsWith("/generate-jitconfig")) {
      const body = JSON.parse(String(init.body));
      const id = 1000 + runners.size;
      runners.set(id, { name: body.name, busy: false });
      return json({ runner: { id }, encoded_jit_config: `jit-${body.name}` }, 201);
    }
    const rm = u.pathname.match(/\/actions\/runners\/(\d+)$/);
    if (rm && method === "DELETE") {
      const r = runners.get(Number(rm[1]));
      if (!r) return new Response("", { status: 404 });
      if (r.busy) return new Response("busy", { status: 422 });
      runners.delete(Number(rm[1]));
      return new Response(null, { status: 204 });
    }
    const jm = u.pathname.match(/\/actions\/jobs\/(\d+)$/);
    if (jm) return json(jobs.get(Number(jm[1])) ?? { status: "queued", conclusion: null, runner_name: null });
    return json({ message: "unhandled" }, 500);
  });

  return { sandboxes, runners, jobs, calls, boatFetch, ghFetch };
}

const ENV = {
  BOAT_API_KEY: "boat_test",
  GITHUB_WEBHOOK_SECRET: "s3cret",
  GITHUB_TOKEN: "ghp_test",
  DINGHY_ADMIN_PASSWORD: "pw",
  DINGHY_INSTANCE: "t",
};

function ev(action: WorkflowJobEvent["action"], id: number, extra: Partial<WorkflowJobEvent["workflow_job"]> = {}): WorkflowJobEvent {
  return {
    action,
    workflow_job: { id, name: "test", workflow_name: "CI", labels: ["self-hosted", "dinghy"], status: action, ...extra },
    repository: { full_name: "acme/app", owner: { login: "acme" } },
  };
}

let f: ReturnType<typeof fakes>;
let orch: Orchestrator;
let store: Store;

beforeEach(async () => {
  f = fakes();
  const cfg = loadConfig(ENV);
  store = new Store(memSql());
  await store.init();
  orch = new Orchestrator(cfg, store, {
    boat: new Boat(cfg.boat.apiKey, cfg.boat.apiBase, null, f.boatFetch),
    gh: new GitHub(cfg.github, f.ghFetch),
    log: () => {},
  });
});

describe("labels", () => {
  test("matches the base label and sized variants", () => {
    expect(matchJob(["self-hosted", "dinghy"], "dinghy", "small")).toBe("small");
    expect(matchJob(["self-hosted", "dinghy-large"], "dinghy", "small")).toBe("large");
    expect(matchJob(["self-hosted", "dinghy", "dinghy-xlarge"], "dinghy", "small")).toBe("xlarge");
    expect(matchJob(["ubuntu-latest"], "dinghy", "small")).toBeNull();
    expect(matchJob(["dinghy-huge"], "dinghy", "small")).toBeNull();
  });
});

describe("job lifecycle", () => {
  test("queued → sandbox with a JIT config, completed → teardown", async () => {
    expect(await orch.onWorkflowJob(ev("queued", 1))).toContain("queued job 1");
    const [sb] = [...f.sandboxes.values()];
    expect(sb!.name).toBe("dinghy-t-1-1");
    expect(sb!.body.noEnv).toBe(true);
    expect(sb!.body.type).toBe("small");
    expect(sb!.body.files[0].content).toBe("jit-dinghy-t-1-1");
    expect(sb!.body.setupScript).toContain("run.sh --jitconfig");

    await orch.onWorkflowJob(ev("in_progress", 1, { runner_name: "dinghy-t-1-1" }));
    expect((await store.runner("dinghy-t-1-1"))!.status).toBe("busy");

    await orch.onWorkflowJob(ev("completed", 1, { runner_name: "dinghy-t-1-1", conclusion: "success" }));
    const r = (await store.runner("dinghy-t-1-1"))!;
    expect(r.status).toBe("done");
    expect(r.cost_usd).toBeGreaterThanOrEqual(0);
    expect(f.sandboxes.size).toBe(0);
    expect((await store.job(1))!.conclusion).toBe("success");
  });

  test("duplicate webhook deliveries start one runner", async () => {
    await orch.onWorkflowJob(ev("queued", 2));
    expect(await orch.onWorkflowJob(ev("queued", 2))).toBe("duplicate delivery");
    expect(f.sandboxes.size).toBe(1);
  });

  test("ignores jobs without our label", async () => {
    expect(await orch.onWorkflowJob(ev("queued", 3, { labels: ["ubuntu-latest"] }))).toContain("ignored");
    expect(f.sandboxes.size).toBe(0);
  });

  test("a job cancelled before start tears down its idle runner", async () => {
    await orch.onWorkflowJob(ev("queued", 4));
    await orch.onWorkflowJob(ev("completed", 4, { conclusion: "cancelled", runner_name: null }));
    expect(f.sandboxes.size).toBe(0);
    expect((await store.job(4))!.status).toBe("cancelled");
  });

  test("respects max concurrency and provisions the backlog on reconcile", async () => {
    const small = new Orchestrator({ ...orch.cfg, runners: { ...orch.cfg.runners, maxConcurrent: 1 } }, store, {
      boat: orch.boat,
      gh: orch.gh,
      log: () => {},
    });
    await small.onWorkflowJob(ev("queued", 5));
    await small.onWorkflowJob(ev("queued", 6));
    expect(f.sandboxes.size).toBe(1);
    expect((await store.job(6))!.status).toBe("queued");
    await small.onWorkflowJob(ev("in_progress", 5, { runner_name: "dinghy-t-5-1" }));
    await small.onWorkflowJob(ev("completed", 5, { runner_name: "dinghy-t-5-1", conclusion: "success" }));
    await small.reconcile();
    expect([...f.sandboxes.values()].map((s) => s.name)).toEqual(["dinghy-t-6-1"]);
  });
});

describe("reconcile", () => {
  test("runner exit (setup done) deletes the sandbox", async () => {
    await orch.onWorkflowJob(ev("queued", 7));
    const sb = [...f.sandboxes.values()][0]!;
    sb.setupStatus = "running";
    await orch.reconcile();
    expect((await store.runner("dinghy-t-7-1"))!.status).toBe("idle");
    // The job ran but we missed its webhooks: GitHub is the source of truth.
    f.jobs.set(7, { status: "completed", conclusion: "success", runner_name: "dinghy-t-7-1" });
    sb.setupStatus = "done";
    await orch.reconcile();
    expect(f.sandboxes.size).toBe(0);
    expect((await store.job(7))!.conclusion).toBe("success");
  });

  test("failed setup requeues the job onto a new runner", async () => {
    await orch.onWorkflowJob(ev("queued", 8));
    [...f.sandboxes.values()][0]!.setupStatus = "failed";
    await orch.reconcile();
    expect((await store.runner("dinghy-t-8-1"))!.status).toBe("failed");
    expect([...f.sandboxes.values()].map((s) => s.name)).toEqual(["dinghy-t-8-2"]);
  });

  test("orphan sandboxes with our prefix are deleted, others are left alone", async () => {
    f.sandboxes.set("bx_orphan01", { id: "bx_orphan01", name: "dinghy-t-99-1", state: "running", body: {} });
    f.sandboxes.set("bx_mine0001", { id: "bx_mine0001", name: "my dev box", state: "running", body: {} });
    await orch.reconcile();
    expect([...f.sandboxes.keys()]).toEqual(["bx_mine0001"]);
  });

  test("a busy idle-timed-out runner is not killed", async () => {
    await orch.onWorkflowJob(ev("queued", 9));
    const r = (await store.runner("dinghy-t-9-1"))!;
    [...f.sandboxes.values()][0]!.setupStatus = "running";
    f.runners.get(r.gh_runner_id!)!.busy = true;
    await store.updateRunner(r.name, { status: "idle", ready_at: 1 });
    await orch.reconcile();
    expect(f.sandboxes.size).toBe(1);
  });
});

describe("http", () => {
  async function sign(body: string) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  test("webhook rejects bad signatures and accepts good ones; dashboard needs auth", async () => {
    const ctx: Ctx = { cfg: orch.cfg, orch, store };
    const app = buildApp(async () => ctx, { name: "bun", defer: () => {} });
    const body = JSON.stringify(ev("queued", 10));
    const bad = await app.request("/webhook", { method: "POST", body, headers: { "x-github-event": "workflow_job", "x-hub-signature-256": "sha256=00" } });
    expect(bad.status).toBe(401);
    const ok = await app.request("/webhook", { method: "POST", body, headers: { "x-github-event": "workflow_job", "x-hub-signature-256": await sign(body) } });
    expect(ok.status).toBe(200);
    expect(f.sandboxes.size).toBe(1);

    expect((await app.request("/")).status).toBe(401);
    const dash = await app.request("/", { headers: { Authorization: `Basic ${btoa("admin:pw")}` } });
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("dinghy-t-10-1");
  });

  test("unconfigured instance shows the setup page", async () => {
    const app = buildApp(async () => ({ error: "Missing required settings: BOAT_API_KEY" }), { name: "bun", defer: () => {} });
    const r = await app.request("/");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("BOAT_API_KEY");
  });
});
