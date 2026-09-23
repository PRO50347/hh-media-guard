#!/usr/bin/env bash
set -euo pipefail
fixture_image="${MEDIA_GUARD_TEST_IMAGE:-hh-media-guard:dev-gate}"
fixture_run="media-guard-e2e-$$"
fixture_network="$fixture_run-network"
fixture_config="$fixture_run-config"
fixture_media="$fixture_run-media"
fixture_app="$fixture_run-app"
fixture_arr="$fixture_run-arr"
fixture_invalid="$fixture_run-invalid"
cleanup() {
  if [ "$?" -ne 0 ]; then
    docker logs "$fixture_app" 2>&1 || true
  fi
  docker rm -f "$fixture_app" "$fixture_arr" "$fixture_invalid" >/dev/null 2>&1 || true
  docker volume rm "$fixture_config" "$fixture_media" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$fixture_invalid" --network none "$fixture_image" >/dev/null
test "$(timeout 15 docker wait "$fixture_invalid")" = 1
docker rm "$fixture_invalid" >/dev/null
docker network create --internal "$fixture_network" >/dev/null
docker volume create "$fixture_config" >/dev/null
docker volume create "$fixture_media" >/dev/null
docker run --rm --user 0 -v "$fixture_media:/fixtures" --entrypoint sh "$fixture_image" -ec '
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
  "$fixture_image" >/dev/null
wait_healthy() {
  for attempt in $(seq 1 30); do
    if docker exec "$fixture_app" wget -q -O /dev/null http://127.0.0.1:3938/api/health; then return; fi
    sleep 1
  done
  return 1
}
wait_healthy
docker exec "$fixture_app" awk '/^Uid:/ { if ($2 == 0 || $3 == 0) exit 1; found=1 } END { if (!found) exit 1 }' /proc/1/status
docker run --rm --network "$fixture_network" -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.62.1-noble npx playwright test
docker stop --time 30 "$fixture_app" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$fixture_app")" = 0
docker start "$fixture_app" >/dev/null
wait_healthy
echo 'Production health, non-root runtime, graceful shutdown and persistent-config restart passed.'
