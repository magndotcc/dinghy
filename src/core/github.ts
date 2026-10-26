import type { Fetcher } from "./boat";
import type { Config } from "./config";

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof buf === "string" ? enc.encode(buf) : buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verifies `X-Hub-Signature-256` over the raw body. */
export async function verifyWebhook(secret: string, body: string, signature: string | null | undefined): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return timingSafeEqual(`sha256=${mac}`, signature);
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** GitHub hands out PKCS#1 keys; WebCrypto wants PKCS#8. Wrap the RSA key in the PKCS#8 envelope. */
function pkcs1ToPkcs8(der: ArrayBuffer): ArrayBuffer {
  const key = new Uint8Array(der);
  const len = (n: number) =>
    n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...len(key.length)];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet];
  const total = inner.length + key.length;
  const out = new Uint8Array([0x30, ...len(total), ...inner, ...key]);
  return out.buffer;
}

async function appJwt(appId: string, pem: string): Promise<string> {
  let der = pemToDer(pem);
  if (pem.includes("BEGIN RSA PRIVATE KEY")) der = pkcs1ToPkcs8(der);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(Date.now() / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(`github ${status}: ${message}`);
  }
}

export interface Target {
  /** "owner/repo" */
  repo: string;
  owner: string;
  installationId: number | null;
}

export class GitHub {
  private tokens = new Map<number, { token: string; exp: number }>();

  constructor(private cfg: Config["github"], private fetcher: Fetcher = (i, o) => fetch(i, o)) {}

  private async token(installationId: number | null): Promise<string> {
    if (this.cfg.appId && this.cfg.appPrivateKey && installationId) {
      const hit = this.tokens.get(installationId);
      if (hit && hit.exp > Date.now() + 60_000) return hit.token;
      const jwt = await appJwt(this.cfg.appId, this.cfg.appPrivateKey);
      const r = await this.raw<{ token: string; expires_at: string }>(
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        undefined,
        `Bearer ${jwt}`,
      );
      this.tokens.set(installationId, { token: r.token, exp: Date.parse(r.expires_at) });
      return r.token;
    }
    if (this.cfg.token) return this.cfg.token;
    throw new GitHubError(0, "no GitHub credentials for this installation");
  }

  private async raw<T>(method: string, path: string, body: unknown, auth: string): Promise<T> {
    const res = await this.fetcher(`${this.cfg.apiBase}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dinghy",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, text.slice(0, 300));
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async api<T>(t: Target, method: string, path: string, body?: unknown): Promise<T> {
    return this.raw<T>(method, path, body, `Bearer ${await this.token(t.installationId)}`);
  }

  private prefix(t: Target): string {
    return this.cfg.runnerScope === "org" ? `/orgs/${t.owner}` : `/repos/${t.repo}`;
  }

  /** Single-use, just-in-time runner registration. The runner removes itself after one job. */
  async jitConfig(t: Target, name: string, labels: string[]): Promise<{ runnerId: number; encoded: string }> {
    const r = await this.api<{ runner: { id: number }; encoded_jit_config: string }>(
      t,
      "POST",
      `${this.prefix(t)}/actions/runners/generate-jitconfig`,
      { name, runner_group_id: this.cfg.runnerGroupId, labels, work_folder: "_work" },
    );
    return { runnerId: r.runner.id, encoded: r.encoded_jit_config };
  }

  /** Returns false when GitHub refuses because the runner is running a job (422). */
  async removeRunner(t: Target, runnerId: number): Promise<boolean> {
    try {
      await this.api(t, "DELETE", `${this.prefix(t)}/actions/runners/${runnerId}`);
      return true;
    } catch (e) {
      // 404: already gone, ephemeral runners deregister themselves after their job.
      if (e instanceof GitHubError && e.status === 404) return true;
      if (e instanceof GitHubError && e.status === 422) return false;
      throw e;
    }
  }

  async jobStatus(t: Target, jobId: number): Promise<{ status: string; conclusion: string | null; runner_name: string | null }> {
    return this.api(t, "GET", `/repos/${t.repo}/actions/jobs/${jobId}`);
  }
}
