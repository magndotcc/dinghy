#!/usr/bin/env bash
# Deploys dinghy to Cloudflare Workers + D1 and sets its secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v bunx >/dev/null || { echo "needs bun: https://bun.sh"; exit 1; }
bun install --frozen-lockfile >/dev/null
W="bunx wrangler"

$W whoami >/dev/null 2>&1 || $W login

if ! grep -q '"database_id"' wrangler.jsonc; then
  echo "==> creating D1 database"
  id=$($W d1 create dinghy --json 2>/dev/null | sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' | head -1 || true)
  [ -z "$id" ] && id=$($W d1 list --json | sed -n 's/.*"uuid": *"\([^"]*\)".*"name": *"dinghy".*/\1/p' | head -1)
  [ -z "$id" ] && { echo "could not create or find the D1 database 'dinghy'"; exit 1; }
  sed -i.bak "s/\"database_name\": \"dinghy\"/\"database_name\": \"dinghy\", \"database_id\": \"$id\"/" wrangler.jsonc && rm -f wrangler.jsonc.bak
fi

existing=$($W secret list 2>/dev/null || echo "[]")
put() {
  if echo "$existing" | grep -q "\"$1\""; then return; fi
  local v="${!1:-}"
  if [ -z "$v" ] && [ -n "${2:-}" ]; then v="$2"; echo "   $1 = $v"; fi
  if [ -z "$v" ]; then read -rsp "$1: " v </dev/tty; echo; fi
  [ -n "$v" ] && printf '%s' "$v" | $W secret put "$1" >/dev/null
}

$W deploy
echo "==> secrets (skipped if already set)"
put BOAT_API_KEY
put GITHUB_TOKEN
put GITHUB_WEBHOOK_SECRET "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
put DINGHY_ADMIN_PASSWORD "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "==> done. Webhook URL: https://<your-worker>.workers.dev/webhook (event: Workflow jobs)"
