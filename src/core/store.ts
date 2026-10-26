/** Minimal async SQL surface implemented by bun:sqlite (VPS/Railway) and D1 (Cloudflare). */
export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  owner TEXT NOT NULL,
  workflow TEXT,
  name TEXT,
  labels TEXT NOT NULL,
  size TEXT NOT NULL,
  installation_id INTEGER,
  status TEXT NOT NULL,
  conclusion TEXT,
  runner_name TEXT,
  html_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS runners (
  name TEXT PRIMARY KEY,
  gh_runner_id INTEGER,
  sandbox_id TEXT,
  repo TEXT NOT NULL,
  owner TEXT NOT NULL,
  installation_id INTEGER,
  size TEXT NOT NULL,
  for_job INTEGER,
  job_id INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  busy_at INTEGER,
  finished_at INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS runners_status ON runners(status);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export type JobStatus = "queued" | "provisioning" | "running" | "completed" | "cancelled" | "skipped";
export type RunnerStatus = "provisioning" | "idle" | "busy" | "draining" | "done" | "failed";

export interface JobRow {
  id: number;
  repo: string;
  owner: string;
  workflow: string | null;
  name: string | null;
  labels: string;
  size: string;
  installation_id: number | null;
  status: JobStatus;
  conclusion: string | null;
  runner_name: string | null;
  html_url: string | null;
  attempts: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunnerRow {
  name: string;
  gh_runner_id: number | null;
  sandbox_id: string | null;
  repo: string;
  owner: string;
  installation_id: number | null;
  size: string;
  for_job: number | null;
  job_id: number | null;
  status: RunnerStatus;
  error: string | null;
  created_at: number;
  ready_at: number | null;
  busy_at: number | null;
  finished_at: number | null;
  cost_usd: number | null;
}

export const now = () => Math.floor(Date.now() / 1000);

export class Store {
  private ready: Promise<void> | null = null;
  constructor(readonly sql: Sql) {}

  init(): Promise<void> {
    this.ready ??= this.sql.exec(SCHEMA);
    return this.ready;
  }

  async getKv<T>(k: string): Promise<T | null> {
    const [r] = await this.sql.all<{ v: string }>("SELECT v FROM kv WHERE k = ?", k);
    return r ? (JSON.parse(r.v) as T) : null;
  }

  async setKv(k: string, v: unknown): Promise<void> {
    await this.sql.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }

  async job(id: number): Promise<JobRow | null> {
    return (await this.sql.all<JobRow>("SELECT * FROM jobs WHERE id = ?", id))[0] ?? null;
  }

  async jobsByStatus(...status: JobStatus[]): Promise<JobRow[]> {
    return this.sql.all<JobRow>(
      `SELECT * FROM jobs WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY queued_at`,
      ...status,
    );
  }

  /** Returns true when the job was new. GitHub redelivers webhooks, so this must be idempotent. */
  async insertJob(j: Omit<JobRow, "status" | "conclusion" | "runner_name" | "attempts" | "started_at" | "finished_at">): Promise<boolean> {
    const r = await this.sql.run(
      `INSERT INTO jobs (id, repo, owner, workflow, name, labels, size, installation_id, html_url, status, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(id) DO NOTHING`,
      j.id, j.repo, j.owner, j.workflow, j.name, j.labels, j.size, j.installation_id, j.html_url, j.queued_at,
    );
    return r.changes > 0;
  }

  async updateJob(id: number, patch: Partial<JobRow>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await this.sql.run(
      `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k]),
      id,
    );
  }

  async runner(name: string): Promise<RunnerRow | null> {
    return (await this.sql.all<RunnerRow>("SELECT * FROM runners WHERE name = ?", name))[0] ?? null;
  }

  async runnersByStatus(...status: RunnerStatus[]): Promise<RunnerRow[]> {
    return this.sql.all<RunnerRow>(
      `SELECT * FROM runners WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY created_at`,
      ...status,
    );
  }

  async insertRunner(r: Pick<RunnerRow, "name" | "repo" | "owner" | "installation_id" | "size" | "for_job">): Promise<void> {
    await this.sql.run(
      `INSERT INTO runners (name, repo, owner, installation_id, size, for_job, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
      r.name, r.repo, r.owner, r.installation_id, r.size, r.for_job, now(),
    );
  }

  async updateRunner(name: string, patch: Partial<RunnerRow>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await this.sql.run(
      `UPDATE runners SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE name = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k]),
      name,
    );
  }

  async activeRunnerCount(): Promise<number> {
    const [r] = await this.sql.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runners WHERE status IN ('provisioning','idle','busy','draining')",
    );
    return Number(r?.n ?? 0);
  }

  async recentJobs(limit = 50): Promise<JobRow[]> {
    return this.sql.all<JobRow>("SELECT * FROM jobs ORDER BY queued_at DESC LIMIT ?", limit);
  }

  async recentRunners(limit = 50): Promise<RunnerRow[]> {
    return this.sql.all<RunnerRow>("SELECT * FROM runners ORDER BY created_at DESC LIMIT ?", limit);
  }

  async usage(from: number, to: number) {
    return this.sql.all<{ owner: string; runners: number; seconds: number; cost_usd: number }>(
      `SELECT owner, COUNT(*) AS runners,
              SUM(COALESCE(finished_at, ?) - created_at) AS seconds,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd
       FROM runners WHERE created_at >= ? AND created_at < ?
       GROUP BY owner ORDER BY cost_usd DESC`,
      now(), from, to,
    );
  }

  async prune(olderThanSeconds: number): Promise<void> {
    const cut = now() - olderThanSeconds;
    await this.sql.run("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?", cut);
    await this.sql.run("DELETE FROM runners WHERE status IN ('done','failed') AND finished_at < ?", cut);
  }
}
