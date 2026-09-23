# Unraid installation and updates

Import `unraid/hh-media-guard.xml` as a local template; Community Applications listing is not assumed. These instructions describe the planned v0.2.2 changes on main, not the immutable v0.2.1 image.

Supply these values:

- **Config:** a dedicated appdata host directory (normally `/mnt/user/appdata/hh-media-guard`), mounted read/write at `/config`. Never mount media or a parent of media here.
- **Media:** your own library host directory, mounted read-only at `/Media`. `MEDIA_ROOTS=/Media` approves that container path. Existing `/movies` and `/tv` layouts remain supported; keep matching roots/mappings.
- **App URL:** the exact browser origin, such as `http://SERVER-IP:3938` or `https://media.example.com`, without a path. Use your own server address. Keep container port 3938; change the host port and App URL together if needed.
- **Encryption Key:** generate once with `openssl rand -base64 32`. This is a 32-byte key encoded in base64, protecting stored Arr credentials. Keep the same key across restart/recreation/update and keep a secure separate backup. No shared default is supplied.
- **Time Zone:** use your region/city or leave `Etc/UTC`. Check the host timezone supplied by Unraid; the template has no personal timezone default.

Optional **Allowed Origins** lists additional exact browser HTTP(S) origins separated by commas. `APP_URL` is always allowed, so leave this blank for a simple LAN install. Reverse proxies must preserve the intended browser origin and host. Wildcards, credentials, paths and query strings are rejected; CSRF protection remains enforced.

Keep **Destructive Actions** false and media read-only. Monitor Only is the default. For a deliberate later change to Quarantine/Automatic, review [operations](operations.md), use a writable quarantine directory outside scanned roots and enable both safety gates.

## Appdata ownership and non-root runtime

The template supplies **PUID=99** and **PGID=100**, the usual Unraid nobody/users IDs. These select the non-root application identity, not media ownership. Both must be non-zero decimal integers at most 2147483647. Without these variables the image retains the historical **100:101** identity, so existing manually-created installs need no new values.

A short root entrypoint validates mounts and prepares only `/config`, the three SQLite files (`media-guard.db`, `-wal`, `-shm`) and the flat `branding` directory/files. It does not recursively chown or chmod. Unknown config entries are untouched. It rejects symlinks/hardlinks in managed entries, nested mounts inside config, configured media overlap and overlapping bind-mount backing paths. It then uses `su-exec` to drop supplementary groups and change UID/GID before executing Node as PID 1. Node/Next.js never runs as root. Default Docker exec commands inherit the image's initialization user; use `docker exec --user PUID:PGID` for non-root maintenance. Explicit Docker `--user` bypasses ownership repair and requires pre-writable appdata; supplied PUID/PGID must match.

Do not put media, symlinks to media or extra mounts inside appdata. Never share one `/config` between running replicas. A host administrator with control of Docker mounts can defeat container isolation; the application cannot protect against a malicious privileged host. No startup code traverses media directories or changes their ownership/mode. Existing data is retained, not reset. Owner bits must still permit reading/writing; read-only mounts and unusual ACLs are diagnosed rather than loosened to world-writable permissions.

## Arr connection setup

`localhost` inside Media Guard means the Media Guard container itself. In ordinary bridge mode use the Unraid host's LAN address and the mapped Arr port: `http://SERVER-IP:8989` for Sonarr, `http://SERVER-IP:7878` for Radarr. Container names work only on a compatible shared custom Docker network with name resolution. Do not enter a browser UI route; include a configured URL base only, such as `http://SERVER-IP:8989/sonarr`. HTTP and trusted HTTPS are supported; certificate verification is never disabled.

Enter the URL and plaintext API key from Arr's settings, then **Test connection before Save**. Testing uses the form's current URL and key without persisting either. After Save/reload the password input is blank; a test then decrypts the saved key server-side. If you change the URL with a blank key, the saved key is used for that explicit test. No saved plaintext key is returned to the browser. Sonarr and Radarr must identify themselves correctly through `/api/v3/system/status`.

Errors distinguish rejected keys (401), forbidden access (403), wrong path/API endpoint (404), wrong service, unexpected response, timeout, DNS, refused/unreachable connection and TLS certificate problems. No upstream response body or raw exception is displayed.

## Existing manual installs

Pulling/updating an image does **not** add template variables or mounts to an already-created Unraid container. The completed template is for new installs. A working v0.2.1 manual install can retain its encryption key, APP_URL, ALLOWED_ORIGINS, media mounts/roots and existing 100:101 appdata owner. PUID/PGID are optional; add both only when intentionally selecting another non-root identity. Keep `/config` mounted at the same dedicated host path. No database reset or manual chown is required for ordinary appdata permissions. Back up appdata and the encryption key before updates. Do not run old and new containers against the same appdata simultaneously.

The fox favicon and Unraid icon remain builder-managed. Other in-app branding is unchanged.

## Startup diagnostics and recovery

Structured `startup.failed` records identify missing/malformed/wrong-length encryption keys, invalid APP_URL versus ALLOWED_ORIGINS, missing/unreadable/unwritable config, database open/migration failure, lease conflicts or other initialization errors. Runtime diagnostics include config path/existence/read/write checks and UID/GID; keys, cookies, credentials and raw exception traces are omitted. Bootstrap rejects unsafe mounts/IDs before Node starts. A runtime lease conflict requires stopping the other instance; after a crash allow 30 seconds for lease expiry.

Wrong encryption keys do not destroy data or silently re-encrypt it: connection tests report inability to decrypt. Restore the original key or deliberately re-enter credentials. Automatic encryption-key generation was not added: storing a new key beside the database would change backup separation, recovery and existing environment-key precedence. An explicit, independently backed-up key avoids accidental regeneration and remains required.

Docker HEALTHCHECK calls unauthenticated, non-mutating `/api/health`, verifying database access and ffprobe. It reports readiness, mode and version without credentials. The 30-second interval, 5-second timeout, 10-second start period and three retries are retained. Do not equate a running container with a healthy one.

Reference: [Unraid container customization](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/).
