#!/usr/bin/env sh
# dinghy VPS installer: Docker + Caddy (auto HTTPS), interactive config.
#   curl -fsSL https://raw.githubusercontent.com/magndotcc/dinghy/main/scripts/install.sh | sh
set -eu

DIR="${DINGHY_DIR:-/opt/dinghy}"
REPO="${DINGHY_REPO:-https://github.com/magndotcc/dinghy}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ask() { # ask VAR "prompt" [default]
  eval "cur=\${$1:-}"
  [ -n "$cur" ] && return
  printf '%s%s: ' "$2" "${3:+ [$3]}" >/dev/tty
  read -r val </dev/tty || true
  eval "$1=\"\${val:-${3:-}}\""
}
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo sh)"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$DIR/.git" ]; then
  say "updating $DIR"; git -C "$DIR" pull --ff-only
else
  say "cloning into $DIR"; git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR/deploy"

if [ ! -f .env ]; then
  ask DINGHY_DOMAIN "Domain pointing at this server (e.g. ci.example.com)"
  ask BOAT_API_KEY "boat.dev API key (boat api-key create dinghy --preset ci --ttl 365d)"
  ask GITHUB_TOKEN "GitHub token with admin on your repos (or leave empty and set GITHUB_APP_* later)"
  ask DINGHY_ALLOWED_OWNERS "GitHub owners allowed (comma-separated, empty = any)"
  GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-$(rand)}"
  DINGHY_ADMIN_PASSWORD="${DINGHY_ADMIN_PASSWORD:-$(rand | head -c 20)}"
  umask 077
  cat > .env <<ENV
DINGHY_DOMAIN=$DINGHY_DOMAIN
BOAT_API_KEY=$BOAT_API_KEY
GITHUB_TOKEN=$GITHUB_TOKEN
GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET
DINGHY_ADMIN_PASSWORD=$DINGHY_ADMIN_PASSWORD
DINGHY_ALLOWED_OWNERS=$DINGHY_ALLOWED_OWNERS
ENV
  say "wrote $DIR/deploy/.env"
fi

say "building and starting"
docker compose --env-file .env up -d --build

. ./.env
cat <<DONE

  dinghy is up at https://$DINGHY_DOMAIN   (user: admin, password: $DINGHY_ADMIN_PASSWORD)

  Add a GitHub webhook (repo or org → Settings → Webhooks):
    Payload URL   https://$DINGHY_DOMAIN/webhook
    Content type  application/json
    Secret        $GITHUB_WEBHOOK_SECRET
    Events        Workflow jobs

  Then in a workflow:  runs-on: [self-hosted, dinghy]
DONE
