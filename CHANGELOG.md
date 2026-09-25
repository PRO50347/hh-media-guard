# Changelog

## 0.2.5

- Make dashboard summary cards clickable shortcuts, with keyboard navigation and hover/focus affordances.
- Link Verified directly to filtered library results, and Wrong Language, Needs Analysis, and Needs Attention directly to their filtered work queues.
- Redesign Needs Attention as a work queue with All / Movies / TV Shows filtering, reason and status filters, and URL-linked filter state.
- Calculate full-dataset summary and filter counts in the database instead of limiting counts to the first 500 attention items.
- Send only 25 full attention records to the browser per page, with pagination and clearer media title, type, source, and reason information.
- Preserve existing attention actions: Rescan, Retry title audit, Reset title limits, Manually accept, and Ignore.

## 0.2.4

- Preserve bounded ffprobe/process diagnostics for inspection failures.
- Retry recognized transient inspection failures once.
- Use exact-file Sonarr/Radarr (Arr) language metadata as the primary language evidence.
- Pass English and multilingual audio that includes English; flag known non-English audio without English as needing attention.
- Fall back to ffprobe language metadata only when Arr language metadata is unavailable.
- Do not let ffprobe `und` override known Arr language metadata.

## 0.2.3

- Resolve missing ffprobe language only with conservative, exact-file Sonarr/Radarr corroboration; retain commentary, descriptive-audio and contradiction protections.
- Stream unpaged Arr library JSON into bounded compact records; retain response/deadline/SSRF limits, avoid redundant Radarr file requests, and support scoped catalog bypass.
- Show structured fallback evidence and distinguish failed scans from media needing attention.
- Add large authenticated HTTP libraries, generated AC3/und fixtures, cache and job-status regressions; extend production lifecycle evidence checks.

## 0.2.2

- Fix wizard navigation losing unsaved Arr credentials, branding and policy edits; await saves, retain failed drafts, and reload persisted settings when revisiting steps. Extend production tests from wizard entry through authenticated generated-media library audits and container recreation.
- Prevent concurrent settings saves from overwriting newer branding or policy changes.
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
