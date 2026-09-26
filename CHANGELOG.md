# Changelog

## 0.2.8

- Support Sonarr episodeFileRenamed and Radarr movieFileRenamed history when correlating imported releases.
- Identify the original imported release after Arr renames or organizes its library file using exact, normalized-safe rename transitions, bounded to 16 hops.
- Fail closed on rename cycles, forks, missing links, multiple reachable imports, and ambiguous history; never fall back to fuzzy or filename-only matching.
- Preserve exact media identity, shared-download refusal, blocklist corroboration before replacement search, and all existing remediation safety gates.
- Prevent the exact legacy pre-mutation redownload-setting failure from incorrectly blocking Manual mode only when database evidence proves no mutation, quarantine, or retry reservation occurred; preserve the original operation and guarded explicit retry.

## 0.2.7

- Add Manual Fix & Redownload mode for explicitly selected, one-at-a-time remediation; normal scans, rescans, schedules, and webhooks remain non-destructive in this mode.
- Enforce one active manual remediation at a time, including queued/running work and pending replacements; uncertain operations require inspection.
- Correct Sonarr/Radarr library-file history correlation to use importedPath instead of the original download droppedPath.
- Use bounded, scoped Arr history lookups while preserving strict download, episode/movie, and shared-release checks.
- Accept realistic nullable and non-string unrelated Arr history metadata without weakening required correlation evidence.
- Require a new, unambiguous matching blocklist entry before replacement search; HTTP success alone never authorizes search.
- Journal mutation intents before dispatch and outcomes separately, preserving refusal to replay uncertain actions.
- Allow explicit guarded retry only for proven pre-mutation failures with revalidated persisted evidence, fingerprint, and exact Arr identity.
- Preserve quarantine-first handling, verified replacement before completion, explicit failed-copy cleanup, and all destructive-action, runtime, path, retry, and cooldown protections. Monitor Only remains the default.
- Improve TV, Movies, and Library performance with server-side search/filtering, 25-item pagination, and batched remediation state lookup for only the current page.

## 0.2.6

- Add a manual Fix & Redownload action for conclusive wrong-language failures from Movies, TV Shows, and relevant Needs Attention items, with explicit confirmation.
- Reuse the existing guarded remediation pipeline and durable jobs, revalidating persisted failed evidence and exact Sonarr/Radarr file identity.
- Remove failed media from the active library through quarantine first, reconcile the missing file with Arr, mark the exact correlated release failed/blocklisted, and trigger a replacement search.
- Show Fixing, Replacement pending, Needs attention, and Complete states while preserving existing Rescan and attention actions.
- Never allow needs-analysis or unknown results to trigger destructive remediation.
- Retain the failed copy in quarantine until a verified replacement passes; offer optional Remove failed copy cleanup with separate confirmation and fresh replacement and quarantine identity checks.
- Preserve retry, cooldown, release-history correlation, idempotency, exact-file identity, path safety, runtime ownership, safety-mode, and destructive-action gates. Monitor Only remains the default; destructive actions are never enabled automatically.

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
