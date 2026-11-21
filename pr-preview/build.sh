#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:?Supply a candidate image tag}"
request="${2:?Supply a pull request number}"
frontend="${3:?Supply the exact pull request head}"
cloud="${4:?Supply the exact Cloud commit}"
[[ "$request" =~ ^[1-9][0-9]{0,9}$ ]]
[[ "$frontend" =~ ^[a-f0-9]{40}$ && "$cloud" =~ ^[a-f0-9]{40}$ ]]

docker build --platform linux/amd64 -f pr-preview/Dockerfile \
  --build-arg "PULL_REQUEST=$request" --build-arg "FRONTEND_COMMIT=$frontend" \
  --build-arg "CLOUD_COMMIT=$cloud" --tag "$image" .
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == "101:101" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "ai.paige.preview.pull-request"}}' "$image")" == "$request" ]]
container="$(docker run --detach --publish 127.0.0.1::8080 "$image")"
trap 'docker rm --force "$container" >/dev/null' EXIT
base="http://$(docker port "$container" 8080/tcp)"
curl --fail --silent --show-error --retry 10 --retry-delay 1 --retry-all-errors --max-time 3 "$base/healthz" >/dev/null
curl --fail --silent --show-error "$base/release.json" \
  | jq -e --arg frontend "$frontend" --arg cloud "$cloud" '.frontendCommit == $frontend and .cloudCommit == $cloud'
home="$(curl --fail --silent --show-error "$base/")"
auth="$(curl --fail --silent --show-error "$base/auth.html")"
grep -Eiq '^<!doctype html' <<< "$home"
grep -Eiq '^<!doctype html' <<< "$auth"
[[ "$home" != "$auth" ]]
[[ "$(curl --fail --silent --show-error "$base/auth?mode=login")" == "$auth" ]]
[[ "$(curl --fail --silent --show-error "$base/solo/preview/command-center")" == "$home" ]]
headers="$(curl --fail --silent --show-error --head "$base/")"
grep -Eiq "^Content-Security-Policy: .*connect-src 'self';.*form-action 'none'" <<< "$headers"
grep -Eiq '^X-Robots-Tag: noindex, nofollow' <<< "$headers"
[[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --request POST "$base/auth")" == "405" ]]
[[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$base/api/status")" == "404" ]]
