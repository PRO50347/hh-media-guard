# H&H Media Guard

H&H Media Guard is a self-hosted companion for Sonarr and Radarr that validates downloaded media audio language metadata with `ffprobe`. It is designed to catch releases that lack usable required-language **main-program** audio—not merely an English commentary or short bonus track.

> **v0.2.2 defaults to Monitor Only.** It scans, records, and reports. Quarantine and Automatic modes require explicit UI selection, writable mounts and the separate environment safety switch.

## Install

```bash
git clone https://github.com/PRO50347/hh-media-guard.git
cd hh-media-guard
cp .env.example .env
# Configure .env and directory permissions as described below first.
docker compose up -d
```

Before starting, generate `ENCRYPTION_KEY` with `openssl rand -base64 32`, set `APP_URL` and media paths in `.env`, and use a dedicated `./config` bind mount. v0.2.2 includes scoped appdata initialization followed by non-root runtime; see the [Docker guide](docs/docker.md) for existing-image behavior.

Open `http://localhost:3938`, complete the setup wizard, and mount media read-only. On Unraid, import [the CA template](unraid/hh-media-guard.xml); see [Unraid guide](docs/unraid.md).

## How decisions work

English (`eng`) is required by default. Language aliases such as `en` and `English` are normalized. Commentary/descriptive streams are excluded by default, and valid tracks must substantially match the program duration (90%) when duration metadata exists. Unknown or missing language metadata becomes **Needs analysis** rather than an unsafe failure. This metadata-based check does not prove spoken language; untagged or incorrectly tagged media needs review.

## Features actually available in v0.2

- Dark responsive H&H Suite-style dashboard and first-run wizard.
- Local administrator account, HttpOnly session cookie, password hashing, CSRF token checking, and exact origin allow-listing for write APIs.
- SQLite settings, scan history, events, fingerprints, mappings, jobs, sessions, and migration ledger persisted under `/config`.
- Complete settings, mappings, language/safety policy, branding uploads and Suite links UI.
- Movies, TV, Jobs, History, Needs Attention and quarantine/restore workflows.
- Full-library, series/season/movie/file and rescan audits with durable leased jobs.
- Safe `ffprobe` process invocation; no shell construction from filenames.
- Mapping-root file validation, per-integration authenticated webhook receiver, typed Arr connection client, idempotent fingerprints and rejection limits.
- Docker image with ffmpeg, non-root runtime, healthcheck, and read-only media-mount examples.

## Screenshots

Screenshots will be added after the initial public release. The dashboard is intentionally usable without any third-party service configured.

## Documentation

- [Architecture](docs/architecture.md)
- [Setup and paths](docs/setup.md) and [Branding / Suite links](docs/branding.md)
- [Docker](docs/docker.md) and [Unraid](docs/unraid.md)
- [Sonarr/Radarr and webhooks](docs/integrations.md)
- [Security, privacy, backup, troubleshooting, development, and releases](docs/operations.md)

## Project status

0.2.2 includes Arr enumeration, secure administration, branding, durable audits, quarantine/restore and automatic remediation validated with mocked Arr services. Replacement search is not proof of a passing replacement: subsequent imported-file inspection verifies it. Optional speech detection remains an interface only; no AI model or detector adapter is installed.

## License

MIT. See [LICENSE](LICENSE).
