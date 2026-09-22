# H&H Media Guard

H&H Media Guard is a self-hosted companion for Sonarr and Radarr that validates downloaded media audio language metadata with `ffprobe`. It is designed to catch releases that lack usable required-language **main-program** audio—not merely an English commentary or short bonus track.

> **v0.2.0 defaults to Monitor Only.** It scans, records, and reports. Quarantine and Arr mutation remain intentionally unavailable in this release; no API route deletes or moves media.

## Install

```bash
git clone https://github.com/PRO50347/hh-media-guard.git
cd hh-media-guard
cp .env.example .env
docker compose up -d
```

Open `http://localhost:3938`, complete the setup wizard, and mount media read-only. On Unraid, import [the CA template](unraid/hh-media-guard.xml); see [Unraid guide](docs/unraid.md).

## How decisions work

English (`eng`) is required by default. Language aliases such as `en` and `English` are normalized. Commentary/descriptive streams are excluded by default, and valid tracks must substantially match the program duration (75%) when duration metadata exists. Unknown or missing language metadata becomes **Needs analysis** rather than an unsafe failure. This metadata-based check does not prove spoken language; untagged or incorrectly tagged media needs review.

## Features actually available in v0.2

- Dark responsive H&H Suite-style dashboard and first-run wizard.
- Local administrator account, HttpOnly session cookie, password hashing, CSRF token checking, and exact origin allow-listing for write APIs.
- SQLite settings, scan history, events, fingerprints, mappings, jobs, sessions, and migration ledger persisted under `/config`.
- Authenticated path-mapping CRUD API and durable queued scan jobs.
- Safe `ffprobe` process invocation; no shell construction from filenames.
- Mapping-root file validation, signed webhook receiver, typed Arr connection client, idempotent fingerprints and rejection limits.
- Docker image with ffmpeg, non-root runtime, healthcheck, and read-only media-mount examples.

## Screenshots

Screenshots will be added after the initial public release. The dashboard is intentionally usable without any third-party service configured.

## Documentation

- [Architecture](docs/architecture.md)
- [Setup and paths](docs/setup.md)
- [Docker](docs/docker.md) and [Unraid](docs/unraid.md)
- [Sonarr/Radarr and webhooks](docs/integrations.md)
- [Security, privacy, backup, troubleshooting, development, and releases](docs/operations.md)

## Project status

0.2.0 establishes secure monitor-only administration and durable jobs. Arr enumeration, branding uploads, quarantine/automatic remediation, and optional AI detection are explicitly deferred; they are not represented as working UI controls.

## License

MIT. See [LICENSE](LICENSE).
