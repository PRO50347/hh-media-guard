# Docker

Use the compose file as a starting point. `/config` is writable and persistent; `/movies` and `/tv` should be `:ro` in Monitor Only. The image runs as an unprivileged `guard` user and includes ffprobe/ffmpeg. Pre-create the config bind directory and grant the image's `guard` UID/GID write access (`docker run --rm --entrypoint id IMAGE` shows them). Do not grant broad permissions to unrelated host directories.

Generate `ENCRYPTION_KEY` with `openssl rand -base64 32` before the first start and keep it securely outside the repository. The key must be canonical base64 encoding of exactly 32 bytes. Existing encrypted credentials require the same key after upgrades/restores. Set `APP_URL` to the exact browser origin, with optional comma-separated exact `ALLOWED_ORIGINS`; wildcard/Host-header trust is not supported. Compose keeps destructive actions disabled.

Run only one application runtime per `/config`. A database lease prevents simultaneous runtimes from recovering each other's active operations. Graceful shutdown releases it; after a crash allow 30 seconds for expiry. The health endpoint checks the local database and ffprobe, never external services.

Back up the entire stopped `/config` and preserve `ENCRYPTION_KEY` separately, or use `node scripts/config-backup.mjs backup /config /path/to/new-backup` for a consistent SQLite snapshot plus referenced branding. Restore with `node scripts/config-backup.mjs restore /path/to/backup /path/to/new-config`; the destination must not exist. These utilities do not back up media or quarantine files. Preserve quarantine storage separately. Never downgrade v0.1 onto a v0.2 database; restore a pre-upgrade backup.
