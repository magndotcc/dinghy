<img src="assets/icon.svg" width="64" height="64" alt="">

# dinghy

**Self-hosted, ephemeral GitHub Actions runners on [boat.dev](https://boat.dev) VMs.**

Add `runs-on: [self-hosted, dinghy]` to a job. dinghy starts a fresh boat VM for it, registers a single-use runner, and deletes the VM when the job is done. You pay boat's per-second price (from $0.018/h for 2 vCPU) and nothing for idle time.

It is one small TypeScript service that you deploy where you like:

| Target | How | State |
|---|---|---|
| **VPS** | `curl … install.sh \| sudo sh`: Docker + Caddy with automatic HTTPS | SQLite on a volume |
| **Cloudflare Workers** | `./scripts/deploy-cloudflare.sh` | D1; reconcile runs on a cron trigger |
| **Railway** | Deploy from this repo; the Dockerfile and `railway.json` are picked up | SQLite on a Railway volume |

```
GitHub ──workflow_job webhook──▶ dinghy ──POST /sandboxes──▶ boat.dev VM (from snapshot, <2 s)
   ▲                               │                             │
   └──── JIT runner registration ──┘        run.sh --jitconfig ──┘  one job, then deleted
```

## What it does

- **Ephemeral, single-use runners.** Each job gets a clean VM and a [JIT runner config](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository). No runner token sits on disk for long, and no state carries over between jobs.
- **Fast starts from a snapshot.** Click **Bake snapshot** on the dashboard. dinghy builds a VM with the Actions runner installed (plus your `DINGHY_BAKE_SCRIPT`), saves it as a boat saved snapshot, and starts every later runner from it.
- **Machine size per job.** Use `dinghy` for the default size, or `dinghy-small`, `dinghy-default`, `dinghy-large` (8 vCPU / 16 GB), `dinghy-xlarge`.
- **No leaked VMs.** VMs are deleted on job completion, on runner exit, after an idle timeout and after a maximum job time. A reconcile loop also reaps any boat sandbox with dinghy's name prefix that it no longer tracks, and every VM has a boat TTL as a hard backstop in case dinghy itself is down.
- **Isolation from your boat account.** Runner VMs are created with `noEnv`, so CI code never sees the secrets, repos or credentials attached to your boat account.
- **Concurrency cap and backlog.** Jobs beyond `DINGHY_MAX_CONCURRENT` queue and start as runners free up. Webhook redeliveries are deduplicated. Jobs cancelled while queued are dropped.
- **Dashboard and usage per owner.** Shows live runners, jobs, boat spend, the GitHub-hosted equivalent cost, and usage per GitHub owner with an optional markup. `/api/usage` returns the same as JSON, so you can bill teams or customers ("a managed runner with 30% margins").
- **GitHub PAT or GitHub App.** Works at repo or org scope.

## Quick start

You need:

1. A boat API key: `boat api-key create dinghy --preset ci --ttl 365d`
2. A GitHub credential that can register runners:
   - **PAT**: classic with `repo` (and `admin:org` for org scope), or fine-grained with *Administration: read & write* on the repos.
   - **or GitHub App**: *Administration: read & write* (repo scope) or *Self-hosted runners: read & write* (org scope). Subscribe it to **Workflow job** events and set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
3. A random webhook secret.

### VPS (any Linux box with a domain)

```sh
curl -fsSL https://raw.githubusercontent.com/magndotcc/dinghy/main/scripts/install.sh | sudo sh
```

It installs Docker if it is missing, asks for a domain, the boat key and the GitHub token, generates the webhook secret and admin password, starts dinghy behind Caddy with HTTPS, and prints the webhook settings. To update, run it again.

Prefer to do it yourself? Run `cd deploy && cp ../.env.example .env && docker compose up -d`, or run the image directly:

```sh
docker run -d -p 8080:8080 -v dinghy:/data --env-file .env ghcr.io/magndotcc/dinghy:latest
```

### Cloudflare Workers

```sh
git clone https://github.com/magndotcc/dinghy && cd dinghy
./scripts/deploy-cloudflare.sh
```

This creates the D1 database, deploys the Worker with a once-a-minute cron for the reconcile loop, and prompts for the secrets.

Or use the [Deploy to Cloudflare button](https://deploy.workers.cloudflare.com/?url=https://github.com/magndotcc/dinghy). Afterwards, set the secrets with `wrangler secret put BOAT_API_KEY`, `wrangler secret put GITHUB_TOKEN`, and so on.

### Railway

1. **New Project → Deploy from GitHub repo →** your fork of `dinghy`. Railway builds the Dockerfile.
2. Add a **volume** mounted at `/data`.
3. Set the variables from [`.env.example`](.env.example). At minimum: `BOAT_API_KEY`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `DINGHY_ADMIN_PASSWORD`.
4. **Settings → Networking → Generate domain.**

With the CLI:

```sh
railway init && railway up
railway volume add --mount-path /data
railway variables --set BOAT_API_KEY=… --set GITHUB_TOKEN=… --set GITHUB_WEBHOOK_SECRET=… --set DINGHY_ADMIN_PASSWORD=…
railway domain
```

### Connect GitHub

On the repo or org, go to **Settings → Webhooks → Add webhook**:

| | |
|---|---|
| Payload URL | `https://<your dinghy>/webhook` |
| Content type | `application/json` |
| Secret | your `GITHUB_WEBHOOK_SECRET` |
| Events | **Workflow jobs** only |

Then in a workflow:

```yaml
jobs:
  test:
    runs-on: [self-hosted, dinghy]        # small: 2 vCPU / 4 GB
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test

  e2e:
    runs-on: [self-hosted, dinghy-large]  # 8 vCPU / 16 GB
```

Open the dashboard (user `admin`, password from `DINGHY_ADMIN_PASSWORD`) and click **Bake snapshot** once.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | |
|---|---|---|
| `BOAT_API_KEY` | required | boat.dev API key (`ci` preset is enough) |
| `GITHUB_WEBHOOK_SECRET` | required | HMAC secret for webhook deliveries |
| `GITHUB_TOKEN` *or* `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | required | runner registration |
| `DINGHY_ADMIN_PASSWORD` | unset | enables the dashboard and `/api/*` (basic auth, user `admin`) |
| `DINGHY_LABEL` | `dinghy` | label that routes jobs to dinghy |
| `DINGHY_DEFAULT_SIZE` | `small` | `small` / `default` / `large` / `xlarge` |
| `DINGHY_MAX_CONCURRENT` | `20` | cap on live VMs; keep it within your boat plan's limits |
| `DINGHY_RUNNER_SCOPE` | `repo` | `repo` or `org` |
| `DINGHY_ALLOWED_OWNERS` | any | comma-separated GitHub owners allowed to use this instance |
| `DINGHY_SNAPSHOT` | baked | use your own boat saved snapshot |
| `DINGHY_BAKE_SCRIPT` | | extra shell for the baked snapshot (toolchains, `docker create` images to keep) |
| `DINGHY_PRE_SCRIPT` | | shell run on every runner before it starts |
| `DINGHY_IDLE_TIMEOUT_SECONDS` | `600` | delete a runner that never got a job |
| `DINGHY_MAX_JOB_SECONDS` | `21600` | hard cap per job |
| `DINGHY_MARKUP_PERCENT` | `0` | markup in the usage report |
| `DINGHY_INSTANCE` | `main` | name prefix; must be unique if several dinghys share one boat account |

## API

All `/api` routes need basic auth.

- `GET /api/status`: live runners, recent jobs, snapshot state
- `GET /api/usage?from=<unix>&to=<unix>`: VM hours, boat cost and billable amount per GitHub owner
- `POST /api/bake`: (re)build the runner snapshot
- `POST /api/reconcile`: run the reconcile loop now
- `GET /healthz`: no auth

## Security notes

- Webhooks are verified with HMAC-SHA256 using a constant-time compare.
- Runner VMs use `noEnv`: no boat account secrets reach CI code. Give jobs secrets the GitHub way.
- Each runner is single-use (JIT config) and its VM is deleted after the job, so nothing persists between jobs. This makes it reasonably safe for public repos, but GitHub still [recommends against](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security) self-hosted runners on public repos that accept PRs from forks.
- Use `DINGHY_ALLOWED_OWNERS` if your GitHub App is installed broadly.

## Develop

```sh
bun install
bun test           # orchestrator tests against in-memory boat + GitHub fakes
bun run dev        # Bun server on :8080 with SQLite in ./data
bun run cf:dev     # same app on workerd + local D1
```

The code is in `src/core/`: the boat client, the GitHub client, the orchestrator state machine, the store, and the Hono app. `src/bun/` and `src/worker/` are thin runtime adapters.

## Not affiliated

dinghy is an independent project. It is not made by boat.dev or GitHub.

MIT licensed.
