# Changelog

## Unreleased — planned 0.2.2

- Fix fresh Unraid appdata permissions with scoped initialization and a non-root PUID/PGID runtime; preserve existing 100:101 defaults. Never recurse into media.
- Add distinct, secret-safe startup and Arr connection diagnostics.
- Fix Sonarr/Radarr unsaved Test Connection, verify the correct service and preserve encrypted saved-key testing across restarts.
- Complete the beginner-friendly Unraid template, networking/upgrade documentation and CI template contract.
- Add production fresh-bind-mount, read-only-media, encrypted-credential, restart/recreate and failure-path gates using isolated Sonarr/Radarr mocks.

## 0.2.1

- Fixed the browser favicon and Docker/Unraid application icon to use the original H&H fox logo.
- Made these two icons builder-managed repository assets, with no user-facing settings or API overrides.
- Preserved all other user-customizable branding, including names, theme/accent, main and compact logos, login artwork, suite visibility and Suite links.

## 0.2.0

- Added local administrator authentication, hashed sessions, CSRF/exact-origin enforcement, encrypted write-only Arr keys and additive v0.1-preserving migrations.
- Added Sonarr/Radarr library, series, season, movie, file and rescan audits; durable leased jobs with bounded execution, progress, cancellation and recovery; authenticated, replay-deduplicated import webhooks.
- Completed integrations, path mappings, language/safety policy, branding uploads and Suite links administration, plus Movies, TV Shows, Jobs, History and Needs Attention views.
- Added guarded quarantine/restore and mock-validated automatic replacement with identity/history correlation, supported Arr failed-history rejection, replacement verification, persistent retry limits and administrator overrides.
- Hardened SSRF/DNS pinning, path/identity checks, raster uploads, operation idempotency and uncertain-outcome recovery. Added generated-media tests, production browser/container gates, migration and backup/restore coverage.
- Documented deployment, security, backups and rollback. Monitor Only remains the default; destructive actions require both gates. Speech detection remains an interface only, with no installed AI model or adapter.

## 0.1.0

- Initial safe Monitor Only release.
