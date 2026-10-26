import type { MachineSize } from "./pricing";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type SandboxState =
  | "init" | "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running"
  | "archiving" | "archived" | "error" | "cancelled";

export interface Sandbox {
  id: string;
  name: string;
  state: SandboxState;
  setupStatus?: "pending" | "running" | "done" | "failed" | null;
  setupError?: string | null;
}

export interface CreateSandbox {
  name: string;
  type: MachineSize;
  ttlSeconds: number;
  from?: string;
  setupScript?: string;
  files?: { path: string; content: string }[];
  env?: Record<string, string>;
}

export class BoatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`boat ${status} ${code}: ${message}`);
  }
}

/** Thin client for https://docs.boat.dev/api/v1 — only what dinghy needs. */
export class Boat {
  constructor(
    private apiKey: string,
    private base = "https://boat.dev/api/v1",
    private org: string | null = null,
    private fetcher: Fetcher = (i, o) => fetch(i, o),
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (this.org) h["X-Boat-Org"] = this.org;
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok || json.ok === false) {
      throw new BoatError(
        res.status,
        json.code ?? json.error?.code ?? "http_error",
        json.message ?? json.error?.message ?? res.statusText,
        json.retryAfterSeconds ?? json.error?.details?.retryAfterSeconds,
      );
    }
    return json as T;
  }

  async create(opts: CreateSandbox, idempotencyKey?: string): Promise<Sandbox> {
    // noEnv: CI jobs run untrusted code, so they never see the account's secrets.
    const body = { noEnv: true, ...opts };
    const r = await this.req<{ sandbox: Sandbox }>(
      "POST",
      "/sandboxes",
      body,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    );
    return r.sandbox;
  }

  async get(id: string): Promise<Sandbox> {
    return (await this.req<{ sandbox: Sandbox }>("GET", `/sandboxes/${id}`)).sandbox;
  }

  async list(): Promise<Sandbox[]> {
    const out: Sandbox[] = [];
    let cursor = "";
    for (let i = 0; i < 50; i++) {
      const r = await this.req<{ sandboxes: Sandbox[]; pageInfo?: { hasMore: boolean; nextCursor: string | null } }>(
        "GET",
        `/sandboxes?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...r.sandboxes);
      if (!r.pageInfo?.hasMore || !r.pageInfo.nextCursor) break;
      cursor = r.pageInfo.nextCursor;
    }
    return out;
  }

  /** Permanently deletes the sandbox; billing stops immediately. */
  async delete(id: string): Promise<void> {
    try {
      await this.req("DELETE", `/sandboxes/${id}`, undefined, { "X-Ascii-Confirm-Delete": id });
    } catch (e) {
      if (e instanceof BoatError && e.status === 404) return;
      throw e;
    }
  }

  async exec(id: string, command: string, timeoutSeconds = 600): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.req("POST", `/sandboxes/${id}/commands`, { command, timeoutSeconds });
  }

  async saveSnapshot(sandboxId: string, name: string): Promise<{ status: string }> {
    const r = await this.req<{ snapshot: { status: string } }>("POST", "/saved-snapshots", { sandboxId, name });
    return r.snapshot;
  }

  async getSnapshot(name: string): Promise<{ status: "saving" | "ready" | "failed"; error?: string | null }> {
    return (await this.req<{ snapshot: { status: "saving" | "ready" | "failed"; error?: string } }>("GET", `/saved-snapshots/${name}`)).snapshot;
  }
}
