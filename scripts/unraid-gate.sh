#!/usr/bin/env bash
set -euo pipefail
fixture_image="${MEDIA_GUARD_TEST_IMAGE:-hh-media-guard:dev-gate}"
fixture_run="mg-unraid-$$"
fixture_dir="$(mktemp -d "$PWD/.unraid-fixture.XXXXXX")"
fixture_network="$fixture_run-net"
fixture_app="$fixture_run-app"
fixture_arr="$fixture_run-arr"
fixture_bad="$fixture_run-bad"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then docker logs "$fixture_app" 2>&1 || true; docker logs "$fixture_bad" 2>&1 || true; fi
  docker rm -f "$fixture_app" "$fixture_arr" "$fixture_bad" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
  docker run --rm --network none --user 0 --entrypoint sh -v "$fixture_dir:/fixture" "$fixture_image" -c 'rm -rf /fixture/*' || true
  rmdir "$fixture_dir"
}
trap cleanup EXIT
mkdir "$fixture_dir/config" "$fixture_dir/media" "$fixture_dir/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=connection-fixture -keyout "$fixture_dir/tls/key.pem" -out "$fixture_dir/tls/cert.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=connection-fixture -addext subjectAltName=DNS:connection-fixture -keyout "$fixture_dir/tls/trusted-key.pem" -out "$fixture_dir/tls/trusted-cert.pem" >/dev/null 2>&1
# All ownership operations below target only disposable test fixtures.
docker run --rm --network none --user 0 --entrypoint sh -v "$fixture_dir:/fixture" "$fixture_image" -ec 'echo generated-fixture > /fixture/media/proof; chown -R 99:100 /fixture/config; chmod 755 /fixture/config; chown -R 345:456 /fixture/media; chmod 555 /fixture/media'
docker network create --internal "$fixture_network" >/dev/null
docker run -d --name "$fixture_arr" --network "$fixture_network" --network-alias connection-fixture -e FIXTURE_TLS=1 -v "$PWD/tests/e2e/connection-fixture.mjs:/fixture.mjs:ro" -v "$fixture_dir/tls:/tls:ro" node:20-alpine node /fixture.mjs >/dev/null
start_app() {
  docker run -d --name "$fixture_app" --network "$fixture_network" --network-alias media-guard \
    -e APP_URL=http://media-guard:3938 -e ENCRYPTION_KEY="${1:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}" \
    -e MEDIA_ROOTS=/Media -e NODE_EXTRA_CA_CERTS=/fixture-ca.crt -v "$fixture_dir/tls/trusted-cert.pem:/fixture-ca.crt:ro" "${runtime_args[@]}" \
    -v "$fixture_dir/config:/config" -v "$fixture_dir/media:/Media:ro" "$fixture_image" >/dev/null
  for attempt in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$fixture_app")" = healthy ]; then break; fi
    sleep 1
  done
  test "$(docker inspect -f '{{.State.Health.Status}}' "$fixture_app")" = healthy
  docker exec "$fixture_app" awk '/^Uid:/ { if ($2 == 0 || $3 == 0) exit 1; found=1 } END { if (!found) exit 1 }' /proc/1/status
  test "$(docker exec "$fixture_app" awk '/^Uid:/ {print $2}' /proc/1/status)" = "$(docker exec "$fixture_app" stat -c %u /config)"
  test "$(docker exec "$fixture_app" awk '/^Gid:/ {print $2}' /proc/1/status)" = "$(docker exec "$fixture_app" stat -c %g /config)"
  test "$(docker exec "$fixture_app" awk '/^CapEff:/ {print $2}' /proc/1/status)" = 0000000000000000
  test "$(docker exec --user "$(docker exec "$fixture_app" stat -c %u:%g /config)" "$fixture_app" readlink /proc/1/exe)" = /usr/local/bin/node
  test "$(docker exec "$fixture_app" stat -c '%u:%g:%a' /Media)" = '345:456:555'
  test "$(docker exec "$fixture_app" stat -c '%u:%g' /Media/proof)" = '345:456'
  test "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/Media"}}{{.RW}}{{end}}{{end}}' "$fixture_app")" = false
  if docker exec "$fixture_app" touch /Media/not-allowed 2>/dev/null; then exit 1; fi
}
persistence() {
  docker exec -i "$fixture_app" node - "$1" <<'JS'
const db = new (require('better-sqlite3'))('/config/media-guard.db');
if (process.argv[2] === 'seed') {
  db.prepare("INSERT INTO scans(path,fingerprint,decision,reason,data,scanned_at) VALUES(?,?,?,?,?,?)").run('/Media/fixture','persistent-fingerprint','unknown','Fixture','{}','2026-01-01');
  db.prepare('INSERT INTO rejections(identity,attempts,updated_at) VALUES(?,?,?)').run('persistent-release',2,'2026-01-01');
  db.prepare('INSERT INTO retry_releases(identity,title_identity,attempts) VALUES(?,?,?)').run('persistent-retry','fixture-title',2);
} else {
  if (db.prepare('SELECT fingerprint FROM scans WHERE path=?').get('/Media/fixture')?.fingerprint !== 'persistent-fingerprint') process.exit(1);
  if (db.prepare('SELECT attempts FROM rejections WHERE identity=?').get('persistent-release')?.attempts !== 2) process.exit(1);
  if (db.prepare('SELECT attempts FROM retry_releases WHERE identity=?').get('persistent-retry')?.attempts !== 2) process.exit(1);
}
db.close();
JS
}
browser() {
  docker run --rm --network "$fixture_network" -e UNRAID_PHASE="$1" -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.62.1-noble npx playwright test
  # Logs must not contain any fixture secrets, cookies or tokens.
  if docker logs "$fixture_app" 2>&1 | rg 'fixture-(sonarr|radarr)-key|fixture-password-123|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=|deliberately-invalid-key'; then exit 1; fi
}
runtime_args=(-e PUID=99 -e PGID=100)
start_app
browser fresh
persistence seed
docker exec "$fixture_app" test -s /config/media-guard.db
# SQLite encrypted data and persisted administration must survive every lifecycle step.
docker exec "$fixture_app" node -e 'const d=new(require("better-sqlite3"))("/config/media-guard.db",{readonly:true});const rows=d.prepare("SELECT encrypted_key FROM integrations").all();if(rows.length!==2||rows.some(r=>r.encrypted_key.includes("fixture-")))process.exit(1)'
docker stop --time 30 "$fixture_app" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$fixture_app")" = 0
docker start "$fixture_app" >/dev/null
sleep 3
browser restart
persistence verify
docker stop --time 30 "$fixture_app" >/dev/null
docker rm "$fixture_app" >/dev/null
runtime_args=() # Existing manual installs: no new variables, predictable 100:101.
start_app
browser recreate
persistence verify
test "$(docker exec "$fixture_app" stat -c '%u:%g' /config/media-guard.db)" = '100:101'
docker stop --time 30 "$fixture_app" >/dev/null
docker rm "$fixture_app" >/dev/null
start_app AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
browser wrong-key
docker stop --time 30 "$fixture_app" >/dev/null
docker rm "$fixture_app" >/dev/null
start_app
browser restored-key
persistence verify
printf '%s\n' 'Fresh Unraid bind mount, Monitor Only, non-root PID 1, healthy, read-only unchanged media, encrypted credentials, restart/recreate and wrong-key recovery passed.'
# Production failure diagnostics and ownership boundary regressions.
negative_cmd=()
reject_start() {
  expected="$1"; shift
  docker run -d --name "$fixture_bad" --network none -e APP_URL=http://media-guard:3938 -e ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= "$@" "$fixture_image" "${negative_cmd[@]}" >/dev/null
  test "$(timeout 25 docker wait "$fixture_bad")" = 1
  docker logs "$fixture_bad" 2>&1 | rg -q "$expected"
  docker logs "$fixture_bad" 2>&1 | python3 -c 'import sys,json; rows=[json.loads(line) for line in sys.stdin if line.startswith("{")]; info=next(x for x in rows if x.get("event")=="startup.failed"); assert all(k in info for k in ["CONFIG_PATH","CONFIG_EXISTS","CONFIG_READABLE","CONFIG_WRITABLE","RUNTIME_UID","RUNTIME_GID"]); assert info["code"]!="config.unwritable" or (not info["CONFIG_WRITABLE"] and info["RUNTIME_UID"]==100)'
  if docker logs "$fixture_bad" 2>&1 | rg 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=|private-key-value|private-password'; then exit 1; fi
  docker rm "$fixture_bad" >/dev/null
}
reject_start 'runtime.conflict' -v "$fixture_dir/config:/config"
reject_start 'encryption.missing' -e ENCRYPTION_KEY=
reject_start 'encryption.malformed' -e ENCRYPTION_KEY=private-key-value
reject_start 'encryption.length' -e ENCRYPTION_KEY=AQID
reject_start 'origin.app_url' -e APP_URL=http://user:private-password@host
reject_start 'origin.allowed' -e ALLOWED_ORIGINS=https://host/path
negative_cmd=(server.js)
reject_start 'config.missing' --user 100:101 --entrypoint node -e CONFIG_DIR=/missing-config
negative_cmd=()
# --entrypoint node explicitly uses the image's server.js CMD and bypasses bootstrap only here.
mkdir "$fixture_dir/denied" "$fixture_dir/bad-db"
chmod 555 "$fixture_dir/denied"
reject_start 'config.unwritable' --user 100:101 -v "$fixture_dir/denied:/config"
chmod 000 "$fixture_dir/denied"
reject_start 'config.unreadable' --user 100:101 -v "$fixture_dir/denied:/config"
docker run --rm --user 0 --network none --entrypoint sh -v "$fixture_dir/bad-db:/fixture" "$fixture_image" -ec 'chown 100:101 /fixture; mkdir /fixture/media-guard.db; chown 100:101 /fixture/media-guard.db'
negative_cmd=(server.js)
reject_start 'database.open' --user 100:101 --entrypoint node -v "$fixture_dir/bad-db:/config"
negative_cmd=()
reject_start 'non-zero decimal' -e PUID=0
reject_start 'non-zero decimal' -e PGID=invalid
reject_start 'overlap' -e MEDIA_ROOTS=/config
reject_start 'overlapping backing storage' -e MEDIA_ROOTS=/Media -v "$fixture_dir/media:/config" -v "$fixture_dir/media:/Media:ro"
reject_start 'Nested mounts' -v "$fixture_dir/config:/config" -v "$fixture_dir/media:/config/branding:ro"
mkdir "$fixture_dir/unsafe"
docker run --rm --network none --user 0 --entrypoint sh -v "$fixture_dir:/fixture" "$fixture_image" -ec 'ln -s /Media /fixture/unsafe/branding'
reject_start 'bootstrap' -v "$fixture_dir/unsafe:/config" -v "$fixture_dir/media:/Media:ro"
docker run --rm --network none --user 0 --entrypoint sh -v "$fixture_dir:/fixture" "$fixture_image" -ec 'rm /fixture/unsafe/branding; ln /fixture/media/proof /fixture/unsafe/media-guard.db'
reject_start 'Unsafe application-owned entry' -v "$fixture_dir/unsafe:/config" -v "$fixture_dir/media:/Media:ro"
test "$(docker exec "$fixture_app" stat -c '%u:%g:%a' /Media)" = '345:456:555'
test "$(docker exec "$fixture_app" stat -c '%u:%g' /Media/proof)" = '345:456'
printf '%s\n' 'Startup diagnostics, config permission failure, invalid IDs, lease conflict, symlink/hardlink/nested-mount/alias rejection and unchanged media passed.'
