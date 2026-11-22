#!/usr/bin/env bash
set -euo pipefail

key="$(openssl rand -hex 32)"
auth="Authorization: Bearer $key"
container="$(docker run -d --cpus=0.75 --memory=384m -e "PAIGE_MEDIA_ORIGIN_KEY=$key" -p 127.0.0.1::8080 "$1")"
tmp="$(mktemp -d)"
cleanup() {
  local status=$?
  if [[ $status != 0 ]]; then docker logs "$container" || true; fi
  docker rm -f "$container" >/dev/null
  rm -r "$tmp"
}
trap cleanup EXIT
origin="http://$(docker port "$container" 8080/tcp)"
for _ in {1..30}; do
  if curl -fsS --max-time 3 "$origin/healthz" > "$tmp/health" 2>/dev/null; then break; fi
  sleep 1
done
grep -qx ok "$tmp/health"

for path in state hls/index.m3u8 replay.mp4; do
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/$path")" == 401 ]]
done
[[ "$(curl -sS -X POST -o /dev/null -w '%{http_code}' "$origin/start")" == 401 ]]
[[ "$(curl -sS -H "$auth" -X POST -o /dev/null -w '%{http_code}' "$origin/start")" == 202 ]]
[[ "$(curl -sS -H "$auth" -X POST -o /dev/null -w '%{http_code}' "$origin/start")" == 409 ]]

for _ in {1..20}; do
  if curl -fsS -H "$auth" "$origin/state" | jq -e '.state == "live"' >/dev/null &&
     curl -fsS --max-time 8 -H "$auth" "$origin/hls/index.m3u8" > "$tmp/index" 2>/dev/null; then
    break
  fi
  sleep 2
done
grep -q '^#EXTM3U' "$tmp/index"
playlist="$(awk '/^[a-zA-Z0-9_-]+\.m3u8\r?$/ {sub(/\r$/, ""); print; exit}' "$tmp/index")"
[[ -n "$playlist" ]]
curl -fsS --max-time 8 -H "$auth" "$origin/hls/$playlist" > "$tmp/playlist"
segment="$(awk '/^[a-zA-Z0-9_-]+\.(mp4|m4s|ts)\r?$/ {sub(/\r$/, ""); print; exit}' "$tmp/playlist")"
[[ -n "$segment" ]]
curl -fsS --max-time 8 -H "$auth" "$origin/hls/$segment" > "$tmp/segment"
[[ "$(wc -c < "$tmp/segment")" -gt 1000 ]]
echo "Verified authenticated live HLS manifest and segment"

for _ in {1..65}; do
  state="$(curl -fsS -H "$auth" "$origin/state" | jq -r '.state')"
  if [[ "$state" == replay ]]; then break; fi
  if [[ "$state" == unavailable ]]; then exit 1; fi
  sleep 2
done
[[ "$state" == replay ]]
[[ "$(curl -fsS -H "$auth" -H 'Range: bytes=0-511' -o "$tmp/replay-header" -w '%{http_code}' "$origin/replay.mp4")" == 206 ]]
grep -aq ftyp "$tmp/replay-header"
curl -fsS -H "$auth" "$origin/replay.mp4" > "$tmp/replay"
docker cp "$tmp/replay" "$container:/tmp/check.mp4"
docker exec "$container" ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/check.mp4 | awk '$1 >= 73 && $1 <= 80 {good=1} END {exit !good}'
echo "Verified recorded replay duration and MP4 byte-range support"
