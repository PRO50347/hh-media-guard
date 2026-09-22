#!/usr/bin/env bash
set -euo pipefail
fixture_run="media-guard-e2e-$$"
fixture_network="$fixture_run-network"
fixture_config="$fixture_run-config"
fixture_media="$fixture_run-media"
fixture_app="$fixture_run-app"
fixture_arr="$fixture_run-arr"
cleanup() {
  docker rm -f "$fixture_app" "$fixture_arr" >/dev/null 2>&1 || true
  docker volume rm "$fixture_config" "$fixture_media" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$fixture_network" >/dev/null
docker volume create "$fixture_config" >/dev/null
docker volume create "$fixture_media" >/dev/null
docker run --rm --user 0 -v "$fixture_media:/fixtures" --entrypoint sh hh-media-guard:dev-gate -ec '
  mkdir -p /fixtures/movies /fixtures/tv /fixtures/quarantine
  ffmpeg -v error -f lavfi -i sine=frequency=440:duration=1 -metadata:s:a:0 language=eng -c:a flac /fixtures/movies/english.mka
  ffmpeg -v error -f lavfi -i sine=frequency=440:duration=1 -metadata:s:a:0 language=spa -c:a flac /fixtures/movies/spanish.mka
  ffmpeg -v error -f lavfi -i sine=frequency=440:duration=1 -metadata:s:a:0 language=und -c:a flac /fixtures/tv/pilot.mka
  chown -R guard:guard /fixtures
'
docker run -d --name "$fixture_arr" --network "$fixture_network" --network-alias arr-fixture -v "$PWD/tests/e2e/mock-arr.mjs:/mock-arr.mjs:ro" node:20-alpine node /mock-arr.mjs >/dev/null
docker run -d --name "$fixture_app" --network "$fixture_network" --network-alias media-guard \
  -e APP_URL=http://media-guard:3938 -e ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  -e ALLOW_DESTRUCTIVE_ACTIONS=true -e MEDIA_ROOTS=/movies,/tv \
  -v "$fixture_config:/config" -v "$fixture_media:/fixtures" \
  --mount "type=volume,src=$fixture_media,dst=/movies,volume-subpath=movies" \
  --mount "type=volume,src=$fixture_media,dst=/tv,volume-subpath=tv" \
  hh-media-guard:dev-gate >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$fixture_app" wget -q -O /dev/null http://127.0.0.1:3938/api/health; then break; fi
  sleep 1
done
docker exec "$fixture_app" wget -q -O /dev/null http://127.0.0.1:3938/api/health
test "$(docker exec "$fixture_app" id -u)" != 0
docker run --rm --network "$fixture_network" -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.62.1-noble npx playwright test
