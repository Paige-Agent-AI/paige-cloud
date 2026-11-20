#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
cloud="$(git rev-parse HEAD)"
[[ "$(git status --porcelain --untracked-files=all)" == "" ]] || {
  echo "Build from a clean Cloud source checkout." >&2
  exit 1
}
[[ "$cloud" == "${EXPECTED_CLOUD_COMMIT:?Set EXPECTED_CLOUD_COMMIT to the reviewed SHA}" ]]
frontend="$(tr -d '\r\n' < upstream.commit)"
[[ "$frontend" =~ ^[a-f0-9]{40}$ ]]
image="${1:?Supply the candidate image name and tag}"

docker build --platform linux/amd64 \
  --build-arg "CLOUD_COMMIT=$cloud" --build-arg "UPSTREAM_COMMIT=$frontend" \
  --tag "$image" .
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == "101:101" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$cloud" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "ai.paige.frontend.revision"}}' "$image")" == "$frontend" ]]

container="$(docker run --detach --publish 127.0.0.1::8080 "$image")"
cleanup() {
  docker logs --tail 40 "$container" >&2 || true
  docker rm --force "$container" >/dev/null || true
}
trap cleanup EXIT
health=""
for attempt in {1..20}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [[ "$health" == healthy ]] && break
  [[ "$health" != unhealthy ]] || break
  sleep 2
done
[[ "$health" == healthy ]]
address="$(docker port "$container" 8080/tcp)"
node scripts/verify-preview.mjs "http://$address" "$cloud" "$frontend"
