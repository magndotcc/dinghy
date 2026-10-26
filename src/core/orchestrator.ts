import { Boat, BoatError } from "./boat";
import { JIT_PATH, bakeScript, runnerScript } from "./bootstrap";
import type { Config } from "./config";
import { GitHub, GitHubError, type Target } from "./github";
import { matchJob } from "./labels";
import { costUsd, type MachineSize } from "./pricing";
import { type JobRow, type RunnerRow, Store, now } from "./store";

export interface WorkflowJobEvent {
  action: "queued" | "in_progress" | "completed" | "waiting";
  workflow_job: {
    id: number;
    name?: string;
    workflow_name?: string;
    labels: string[];
    status: string;
    conclusion?: string | null;
    runner_name?: string | null;
    html_url?: string;
  };
  repository: { full_name: string; owner: { login: string } };
  installation?: { id: number };
}

export interface BakeState {
  status: "creating" | "installing" | "saving" | "ready" | "failed";
  sandboxId?: string;
  snapshot: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const PROVISION_TIMEOUT = 10 * 60;
const MAX_ATTEMPTS = 3;

export class Orchestrator {
  readonly boat: Boat;
  readonly gh: GitHub;
  private log: (msg: string, extra?: unknown) => void;

  constructor(
    readonly cfg: Config,
    readonly store: Store,
    deps: { boat?: Boat; gh?: GitHub; log?: (msg: string, extra?: unknown) => void } = {},
  ) {
    this.boat = deps.boat ?? new Boat(cfg.boat.apiKey, cfg.boat.apiBase, cfg.boat.org);
    this.gh = deps.gh ?? new GitHub(cfg.github);
    this.log = deps.log ?? ((m, e) => console.log(`[dinghy] ${m}`, e ?? ""));
  }

  get prefix(): string {
    return `dinghy-${this.cfg.instance}-`;
  }

  private target(r: { repo: string; owner: string; installation_id: number | null }): Target {
    return { repo: r.repo, owner: r.owner, installationId: r.installation_id };
  }

  async snapshotName(): Promise<string | null> {
    if (this.cfg.runners.snapshot) return this.cfg.runners.snapshot;
    const bake = await this.store.getKv<BakeState>("bake");
    return bake?.status === "ready" ? bake.snapshot : null;
  }

  // ---------------------------------------------------------------- webhooks

  /** Handles a `workflow_job` delivery. Returns a short human-readable outcome. */
  async onWorkflowJob(ev: WorkflowJobEvent): Promise<string> {
    const job = ev.workflow_job;
    const owner = ev.repository.owner.login.toLowerCase();
    const allowed = this.cfg.github.allowedOwners;
    if (allowed.length && !allowed.includes(owner)) return `ignored: owner ${owner} not allowed`;

    if (ev.action === "queued") {
      const size = matchJob(job.labels, this.cfg.runners.label, this.cfg.runners.defaultSize);
      if (!size) return "ignored: labels do not match";
      const fresh = await this.store.insertJob({
        id: job.id,
        repo: ev.repository.full_name,
        owner,
        workflow: job.workflow_name ?? null,
        name: job.name ?? null,
        labels: JSON.stringify(job.labels),
        size,
        installation_id: ev.installation?.id ?? null,
        html_url: job.html_url ?? null,
        queued_at: now(),
      });
      if (!fresh) return "duplicate delivery";
      await this.provision(job.id);
      return `queued job ${job.id} on ${size}`;
    }

    const known = await this.store.job(job.id);
    if (!known) return "ignored: unknown job";

    if (ev.action === "in_progress") {
      await this.store.updateJob(job.id, { status: "running", started_at: now(), runner_name: job.runner_name ?? null });
      if (job.runner_name?.startsWith(this.prefix)) {
        await this.store.updateRunner(job.runner_name, { status: "busy", busy_at: now(), job_id: job.id });
      }
      return `job ${job.id} running on ${job.runner_name}`;
    }

    if (ev.action === "completed") {
      const cancelledBeforeStart = !job.runner_name;
      await this.store.updateJob(job.id, {
        status: cancelledBeforeStart ? "cancelled" : "completed",
        conclusion: job.conclusion ?? null,
        finished_at: now(),
      });
      if (job.runner_name?.startsWith(this.prefix)) {
        const r = await this.store.runner(job.runner_name);
        if (r) await this.teardown(r, "done");
      } else if (cancelledBeforeStart) {
        // The runner we started for this job may now sit idle; take it down unless it found other work.
        const [r] = await this.store.sql.all<RunnerRow>(
          "SELECT * FROM runners WHERE for_job = ? AND status IN ('provisioning','idle')",
          job.id,
        );
        if (r) await this.teardown(r, "done", { onlyIfIdle: true });
      }
      return `job ${job.id} ${job.conclusion ?? "completed"}`;
    }
    return "ignored";
  }

  // ------------------------------------------------------------ provisioning

  /** Starts one ephemeral runner for a queued job. Safe to call concurrently. */
  async provision(jobId: number): Promise<void> {
    if ((await this.store.activeRunnerCount()) >= this.cfg.runners.maxConcurrent) return;
    const claim = await this.store.sql.run(
      "UPDATE jobs SET status = 'provisioning', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
      jobId,
    );
    if (!claim.changes) return;
    const job = (await this.store.job(jobId))!;
    const name = `${this.prefix}${jobId}-${job.attempts}`;
    const t = this.target(job);
    await this.store.insertRunner({
      name,
      repo: job.repo,
      owner: job.owner,
      installation_id: job.installation_id,
      size: job.size,
      for_job: jobId,
    });

    try {
      const labels = JSON.parse(job.labels) as string[];
      const jit = await this.gh.jitConfig(t, name, [...new Set(["self-hosted", this.cfg.runners.label, ...labels])]);
      await this.store.updateRunner(name, { gh_runner_id: jit.runnerId });
      const from = await this.snapshotName();
      const sandbox = await this.boat.create(
        {
          name,
          type: job.size as MachineSize,
          // Hard ceiling: if dinghy dies, boat auto-stops the VM anyway.
          ttlSeconds: this.cfg.runners.maxJobSeconds + PROVISION_TIMEOUT,
          ...(from ? { from } : {}),
          files: [{ path: JIT_PATH, content: jit.encoded }],
          setupScript: runnerScript(this.cfg.runners.runnerVersion, this.cfg.runners.preScript),
        },
        name,
      );
      await this.store.updateRunner(name, { sandbox_id: sandbox.id });
      this.log(`runner ${name} → sandbox ${sandbox.id} (${job.size}${from ? `, from ${from}` : ""})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`provision ${name} failed: ${msg}`);
      const r = await this.store.runner(name);
      if (r) await this.teardown(r, "failed", { error: msg });
      const retry = job.attempts < MAX_ATTEMPTS && !(e instanceof GitHubError && e.status < 500 && e.status !== 429);
      await this.store.updateJob(jobId, { status: retry ? "queued" : "skipped" });
    }
  }

  /** Removes the GitHub runner registration and deletes the VM. */
  async teardown(r: RunnerRow, status: "done" | "failed", opts: { error?: string; onlyIfIdle?: boolean } = {}): Promise<void> {
    if (r.status === "done" || r.status === "failed") return;
    if (opts.onlyIfIdle && (await this.store.runner(r.name))?.status === "busy") return;
    const t = this.target(r);
    if (r.gh_runner_id) {
      try {
        const removed = await this.gh.removeRunner(t, r.gh_runner_id);
        // GitHub refuses to remove a runner that is mid-job: it picked up work, so leave it alone.
        if (!removed && opts.onlyIfIdle) return;
      } catch (e) {
        this.log(`remove runner ${r.name}: ${(e as Error).message}`);
      }
    }
    if (r.sandbox_id) {
      try {
        await this.boat.delete(r.sandbox_id);
      } catch (e) {
        this.log(`delete sandbox ${r.sandbox_id}: ${(e as Error).message}`);
        await this.store.updateRunner(r.name, { status: "draining", error: (e as Error).message });
        return;
      }
    }
    const end = now();
    await this.store.updateRunner(r.name, {
      status,
      error: opts.error ?? r.error,
      finished_at: end,
      cost_usd: r.sandbox_id ? costUsd(r.size as MachineSize, end - r.created_at) : 0,
    });
  }

  // --------------------------------------------------------------- reconcile

  /** Idempotent housekeeping. Run every ~30 s (Bun) or every minute (Cloudflare cron). */
  async reconcile(): Promise<{ provisioned: number; reaped: number }> {
    let reaped = 0;
    const t = now();

    for (const r of await this.store.runnersByStatus("provisioning", "idle", "busy", "draining")) {
      try {
        if (r.status === "draining") {
          await this.teardown({ ...r, status: "idle" }, r.error ? "failed" : "done");
          reaped++;
          continue;
        }
        if (!r.sandbox_id) {
          if (t - r.created_at > 120) {
            await this.teardown(r, "failed", { error: "never got a sandbox" });
            reaped++;
          }
          continue;
        }
        const sb = await this.boat.get(r.sandbox_id).catch((e) => {
          if (e instanceof BoatError && e.status === 404) return null;
          throw e;
        });
        if (!sb || ["archived", "archiving", "error", "cancelled"].includes(sb.state)) {
          await this.teardown(r, r.status === "busy" ? "done" : "failed", { error: sb ? `sandbox ${sb.state}` : "sandbox gone" });
          reaped++;
          continue;
        }
        if (sb.setupStatus === "failed") {
          await this.teardown(r, "failed", { error: sb.setupError ?? "setup failed" });
          await this.requeue(r);
          reaped++;
          continue;
        }
        if (sb.setupStatus === "done") {
          // run.sh exited: the one job is over (or the runner crashed).
          await this.teardown(r, "done");
          reaped++;
          continue;
        }
        if (r.status === "provisioning") {
          if (sb.setupStatus === "running") await this.store.updateRunner(r.name, { status: "idle", ready_at: t });
          else if (t - r.created_at > PROVISION_TIMEOUT) {
            await this.teardown(r, "failed", { error: "provisioning timed out" });
            await this.requeue(r);
            reaped++;
          }
          continue;
        }
        if (r.status === "idle" && t - (r.ready_at ?? r.created_at) > this.cfg.runners.idleTimeoutSeconds) {
          await this.teardown(r, "done", { onlyIfIdle: true, error: "idle timeout" });
          reaped++;
          continue;
        }
        if (r.status === "busy" && t - (r.busy_at ?? r.created_at) > this.cfg.runners.maxJobSeconds) {
          await this.teardown(r, "failed", { error: "max job time exceeded" });
          reaped++;
        }
      } catch (e) {
        this.log(`reconcile ${r.name}: ${(e as Error).message}`);
      }
    }

    // Jobs stuck in "provisioning" without a live runner (e.g. crash mid-provision).
    for (const j of await this.store.jobsByStatus("provisioning")) {
      const [live] = await this.store.sql.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM runners WHERE for_job = ? AND status IN ('provisioning','idle','busy')",
        j.id,
      );
      if (Number(live?.n)) continue;
      // Our runner is gone. If it picked the job up, the in_progress/completed webhooks may have been missed.
      const s = await this.gh.jobStatus(this.target(j), j.id).catch(() => null);
      if (s?.status === "completed") {
        await this.store.updateJob(j.id, { status: "completed", conclusion: s.conclusion, runner_name: s.runner_name, finished_at: t });
      } else if (s?.status === "in_progress") {
        await this.store.updateJob(j.id, { status: "running", runner_name: s.runner_name, started_at: t });
      } else {
        await this.store.updateJob(j.id, { status: j.attempts < MAX_ATTEMPTS ? "queued" : "skipped" });
      }
    }

    // Queued jobs: drop the ones GitHub already cancelled, provision the rest.
    let provisioned = 0;
    for (const j of await this.store.jobsByStatus("queued")) {
      if (t - j.queued_at > 600) {
        const s = await this.gh.jobStatus(this.target(j), j.id).catch(() => null);
        if (s && s.status === "completed") {
          await this.store.updateJob(j.id, { status: "cancelled", conclusion: s.conclusion, finished_at: t });
          continue;
        }
      }
      if ((await this.store.activeRunnerCount()) >= this.cfg.runners.maxConcurrent) break;
      await this.provision(j.id);
      provisioned++;
    }

    reaped += await this.reapOrphans();
    await this.advanceBake();
    if (t % 3600 < 60) await this.store.prune(30 * 86400);
    return { provisioned, reaped };
  }

  private async requeue(r: RunnerRow): Promise<void> {
    if (!r.for_job) return;
    const j = await this.store.job(r.for_job);
    if (j && j.status === "provisioning") await this.store.updateJob(j.id, { status: j.attempts < MAX_ATTEMPTS ? "queued" : "skipped" });
  }

  /** Deletes boat sandboxes named like ours that dinghy no longer tracks. */
  private async reapOrphans(): Promise<number> {
    let n = 0;
    const live = new Set(
      (await this.store.runnersByStatus("provisioning", "idle", "busy", "draining")).map((r) => r.sandbox_id).filter(Boolean),
    );
    const bake = await this.store.getKv<BakeState>("bake");
    if (bake?.sandboxId) live.add(bake.sandboxId);
    let sandboxes;
    try {
      sandboxes = await this.boat.list();
    } catch (e) {
      this.log(`list sandboxes: ${(e as Error).message}`);
      return 0;
    }
    for (const sb of sandboxes) {
      if (!sb.name?.startsWith(this.prefix) || live.has(sb.id)) continue;
      // Give a just-created sandbox a moment before the runner row records its id.
      const r = await this.store.runner(sb.name);
      if (r && (r.status === "provisioning") && now() - r.created_at < 120) continue;
      await this.boat.delete(sb.id).catch(() => {});
      this.log(`reaped orphan sandbox ${sb.id} (${sb.name})`);
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------- bake

  /** Creates a sandbox with the runner pre-installed and saves it, so runners boot in seconds. */
  async startBake(): Promise<BakeState> {
    const prev = await this.store.getKv<BakeState>("bake");
    if (prev && ["creating", "installing", "saving"].includes(prev.status)) return prev;
    const snapshot = `dinghy-${this.cfg.instance}-runner`;
    const state: BakeState = { status: "creating", snapshot, startedAt: now() };
    await this.store.setKv("bake", state);
    try {
      const sb = await this.boat.create({
        name: `${this.prefix}bake`,
        type: "default",
        ttlSeconds: 3600,
        setupScript: bakeScript(this.cfg.runners.runnerVersion, this.cfg.runners.bakeScript),
      });
      state.status = "installing";
      state.sandboxId = sb.id;
    } catch (e) {
      state.status = "failed";
      state.error = (e as Error).message;
    }
    await this.store.setKv("bake", state);
    return state;
  }

  async advanceBake(): Promise<void> {
    const s = await this.store.getKv<BakeState>("bake");
    if (!s || !s.sandboxId || !["installing", "saving"].includes(s.status)) return;
    const fail = async (error: string) => {
      await this.boat.delete(s.sandboxId!).catch(() => {});
      await this.store.setKv("bake", { ...s, status: "failed", error, finishedAt: now() });
    };
    try {
      if (s.status === "installing") {
        const sb = await this.boat.get(s.sandboxId);
        if (sb.setupStatus === "failed") return fail(sb.setupError ?? "bake script failed");
        if (sb.setupStatus !== "done") {
          if (now() - s.startedAt > 1800) return fail("bake timed out");
          return;
        }
        await this.boat.saveSnapshot(s.sandboxId, s.snapshot);
        await this.store.setKv("bake", { ...s, status: "saving" });
        return;
      }
      const snap = await this.boat.getSnapshot(s.snapshot);
      if (snap.status === "failed") return fail(snap.error ?? "snapshot save failed");
      if (snap.status === "ready") {
        await this.boat.delete(s.sandboxId).catch(() => {});
        await this.store.setKv("bake", { ...s, status: "ready", sandboxId: undefined, finishedAt: now() });
        this.log(`snapshot ${s.snapshot} ready`);
      }
    } catch (e) {
      this.log(`bake: ${(e as Error).message}`);
    }
  }
}

export type { JobRow, RunnerRow };
