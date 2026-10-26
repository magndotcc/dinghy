import type { MachineSize } from "./pricing";

export interface Config {
  /** Short id baked into every runner/sandbox name so several installs can share one boat account. */
  instance: string;
  publicUrl: string | null;
  adminPassword: string | null;
  boat: { apiKey: string; apiBase: string; org: string | null };
  github: {
    webhookSecret: string;
    token: string | null;
    appId: string | null;
    appPrivateKey: string | null;
    apiBase: string;
    /** "repo" registers runners per repository, "org" on the organization. */
    runnerScope: "repo" | "org";
    runnerGroupId: number;
    allowedOwners: string[];
  };
  runners: {
    /** Jobs must carry this label (or `<label>-<size>`) to be picked up. */
    label: string;
    defaultSize: MachineSize;
    snapshot: string | null;
    maxConcurrent: number;
    idleTimeoutSeconds: number;
    maxJobSeconds: number;
    runnerVersion: string;
    preScript: string;
    bakeScript: string;
  };
  billing: { markupPercent: number; currency: string };
}

export type Env = Record<string, string | undefined>;

const SIZES = ["small", "default", "large", "xlarge"] as const;

function int(v: string | undefined, d: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export class ConfigError extends Error {}

export function loadConfig(env: Env): Config {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? "";
  };
  const boatKey = need("BOAT_API_KEY");
  const webhookSecret = need("GITHUB_WEBHOOK_SECRET");
  const token = env.GITHUB_TOKEN?.trim() || null;
  const appId = env.GITHUB_APP_ID?.trim() || null;
  const appPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() || null;
  if (!token && !(appId && appPrivateKey)) missing.push("GITHUB_TOKEN (or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY)");
  if (missing.length) throw new ConfigError(`Missing required settings: ${missing.join(", ")}`);

  const size = (env.DINGHY_DEFAULT_SIZE ?? "small") as MachineSize;
  if (!SIZES.includes(size)) throw new ConfigError(`DINGHY_DEFAULT_SIZE must be one of ${SIZES.join(", ")}`);
  const scope = env.DINGHY_RUNNER_SCOPE === "org" ? "org" : "repo";

  return {
    instance: (env.DINGHY_INSTANCE ?? "main").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "main",
    publicUrl: env.DINGHY_PUBLIC_URL?.replace(/\/$/, "") || null,
    adminPassword: env.DINGHY_ADMIN_PASSWORD || null,
    boat: {
      apiKey: boatKey,
      apiBase: (env.BOAT_API_BASE ?? "https://boat.dev/api/v1").replace(/\/$/, ""),
      org: env.BOAT_ORG || null,
    },
    github: {
      webhookSecret,
      token,
      appId,
      appPrivateKey,
      apiBase: (env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, ""),
      runnerScope: scope,
      runnerGroupId: int(env.DINGHY_RUNNER_GROUP_ID, 1),
      allowedOwners: list(env.DINGHY_ALLOWED_OWNERS),
    },
    runners: {
      label: (env.DINGHY_LABEL ?? "dinghy").toLowerCase(),
      defaultSize: size,
      snapshot: env.DINGHY_SNAPSHOT || null,
      maxConcurrent: int(env.DINGHY_MAX_CONCURRENT, 20),
      idleTimeoutSeconds: int(env.DINGHY_IDLE_TIMEOUT_SECONDS, 600),
      maxJobSeconds: int(env.DINGHY_MAX_JOB_SECONDS, 6 * 3600),
      runnerVersion: env.DINGHY_RUNNER_VERSION ?? "2.338.2",
      preScript: env.DINGHY_PRE_SCRIPT ?? "",
      bakeScript: env.DINGHY_BAKE_SCRIPT ?? "",
    },
    billing: {
      markupPercent: Number(env.DINGHY_MARKUP_PERCENT ?? "0") || 0,
      currency: env.DINGHY_CURRENCY ?? "USD",
    },
  };
}
