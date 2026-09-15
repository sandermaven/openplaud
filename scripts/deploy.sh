#!/usr/bin/env bash
#
# Deploy OpenPlaud on the VM.
#
# Fast-forwards the checkout in $APP_DIR to the tip of origin/$DEPLOY_BRANCH and,
# when that moved anything, rebuilds the app image and waits for the container to
# report healthy. The image is built from this checkout (docker-compose.yml uses
# `build: .`), so the rebuild is what ships new code; database migrations run from
# the container entrypoint on start, not from here.
#
# Runs ON the VM. Both callers deliberately run it from a copy outside the
# checkout, because the `git reset` below rewrites this very file and bash reads
# a script incrementally:
#   - deploy/systemd/openplaud-deploy.service copies it to /run first
#   - .github/workflows/deploy.yml copies it to /tmp with `gcloud compute scp`
# Running it by hand over SSH is fine too; only an in-place edit of this file
# during a run would be a problem.
#
# Environment:
#   APP_DIR         checkout to deploy          (default /opt/openplaud)
#   DEPLOY_BRANCH   branch to follow            (default main)
#   APP_CONTAINER   container to health-check   (default openplaud-app)
#   HEALTH_TIMEOUT  seconds to wait for health  (default 300)
#   FORCE           1 to rebuild even when the branch did not move

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/openplaud}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
APP_CONTAINER="${APP_CONTAINER:-openplaud-app}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
FORCE="${FORCE:-0}"

# The timer fires on a schedule, so a slow build must not have a second deploy
# start on top of it. A concurrent run is normal, not an error.
exec 9>"/tmp/openplaud-deploy.lock"
if ! flock -n 9; then
    echo "Another deploy is in progress; skipping this run."
    exit 0
fi

cd "$APP_DIR"

# A hotfix applied straight on the VM would be destroyed by the reset below, so
# stop rather than discard it silently. Untracked files (.env) are not affected.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Refusing to deploy: tracked files in $APP_DIR were modified on the VM." >&2
    git status --short --untracked-files=no >&2
    exit 1
fi

current="$(git rev-parse HEAD)"

git fetch --prune origin
target="$(git rev-parse "origin/$DEPLOY_BRANCH")"

if [ "$current" = "$target" ] && [ "$FORCE" != "1" ]; then
    echo "Already at ${current:0:12}; nothing to deploy."
    exit 0
fi

echo "Deploying ${current:0:12} -> ${target:0:12} (origin/$DEPLOY_BRANCH)"
git reset --hard "$target"

docker compose up -d --build

# Report the deploy as failed when the new container never becomes healthy,
# instead of leaving a crash-looping app behind a green checkmark.
echo "Waiting for $APP_CONTAINER to become healthy (timeout ${HEALTH_TIMEOUT}s)..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while true; do
    state="$(docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}}' \
        "$APP_CONTAINER" 2>/dev/null || echo missing)"

    case "$state" in
        healthy)
            echo "$APP_CONTAINER is healthy."
            break
            ;;
        nohealthcheck)
            echo "$APP_CONTAINER has no healthcheck; treating a running container as deployed."
            break
            ;;
        starting)
            ;;
        *)
            # "unhealthy" is only set after the healthcheck's retries are spent
            # outside its start period, so it is a real failure, not a slow boot.
            echo "$APP_CONTAINER reported '$state'. Deploy failed." >&2
            docker compose logs --tail 50 app >&2 || true
            echo "Roll back with: cd $APP_DIR && git reset --hard $current && docker compose up -d --build" >&2
            exit 1
            ;;
    esac

    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "$APP_CONTAINER was still '$state' after ${HEALTH_TIMEOUT}s. Deploy failed." >&2
        docker compose logs --tail 50 app >&2 || true
        echo "Roll back with: cd $APP_DIR && git reset --hard $current && docker compose up -d --build" >&2
        exit 1
    fi
    sleep 5
done

# Each rebuild leaves the previous image behind; the VM only has a 30 GB disk.
docker image prune -f >/dev/null

echo "Deployed ${target:0:12}."
