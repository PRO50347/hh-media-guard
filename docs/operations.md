# Operations

## Safety and recovery

Monitor Only is the default and never mutates Arr or media. Quarantine moves conclusively failed files into a configured directory. Automatic adds the [replacement workflow](integrations.md). Both mutating modes require `ALLOW_DESTRUCTIVE_ACTIONS=true`, writable fixture/media mounts, and a writable quarantine directory outside scanned roots. Unknown audio metadata never authorizes a move. Use Monitor Only to assess metadata quality first.

One runtime owns each `/config` using a database lease. The worker deliberately runs at concurrency **one**, bounding ffprobe and destructive operations and avoiding overlapping remediation. Queue claims, progress and completion are lease-fenced. Cancellation revokes ownership immediately; active inspection observes it within 250 ms, while an in-flight Arr request can take up to its eight-second timeout. Enumeration checks cancellation between requests. SIGTERM/SIGINT drains the worker and releases runtime ownership. Stopped jobs retry durably; crashed leases recover after expiry, with at most three attempts before Needs Attention. Audits restart enumeration after interruption and deduplicate unchanged file fingerprints. Progress totals describe the current attempt, including inspected/skipped items.

Replacement budgets persist per title and rejected release/download identity. Cooldown doubles after each attempt, capped at seven days. Needs Attention → Retry title audit reads current Arr identity and respects existing limits. Reset title limits clears the budget and manual pause, but **never erases or replays the destructive-operation journal**. Accept and Ignore preserve scan evidence and pause future automatic replacement of an identified title. Use the status filter to find accepted/ignored entries for reset. Overrides are audited.

Interrupted or uncertain external actions require manual reconciliation. Examine evidence, Arr history/commands, and the Quarantine page before deciding whether to restore. Restore requires both safety gates, verifies identity, and refuses destination collisions. Cross-filesystem moves copy exclusively, sync and verify before unlinking the original. Partial failure preserves available copies and marks attention. There is no automatic retention deletion. Linux `/proc` and trusted administrator-controlled mount directories are required; a hostile host administrator or arbitrary concurrent filesystem writer is outside the protection boundary.

## Security and privacy

Keep the application on a trusted network or behind a TLS reverse proxy. Built-in local administrator authentication, hashed sessions, CSRF tokens and exact allowed origins protect administrative APIs. `APP_URL` must match the browser's actual origin; add only required exact origins to `ALLOWED_ORIGINS`. Never set `MG_BUILD=1` at runtime. Startup fails on invalid encryption configuration. Keep API keys and the encryption key out of logs, screenshots, repositories and support bundles.

No media is uploaded to a cloud service. The installed worker uses ffprobe metadata only. The optional detector module is a bounded code-level interface, with no adapter, model, sidecar or AI worker execution installed. It must not be presented as spoken-language verification. See [security review](security-review.md).

## Backup, restore and rollback

Stop the application before a full directory backup and copy `/config`; preserve `ENCRYPTION_KEY` separately. Alternatively run `node scripts/config-backup.mjs backup /config /backups/NEW_NAME` in an environment with the packaged Node dependencies and mounted backup destination. It creates a consistent SQLite snapshot, checks integrity, and copies referenced branding with a checksum manifest. Destination must be new. Backups contain credentials and session data: restrict access.

Restore while stopped using `node scripts/config-backup.mjs restore /backups/NAME /new-config`. The tool validates paths, regular files, checksums and SQLite integrity, and refuses an existing destination. Point the replacement container at the restored directory with the same encryption key and suitable owner permissions. Neither utility backs up media/quarantine storage; preserve that separately.

Upgrades use additive migration records and preserve v0.1 settings/scans/events/rejections. Before upgrading, keep a separate pre-upgrade backup and record the image digest. To roll back to v0.1, stop v0.2, preserve its config separately, and restore the pre-upgrade v0.1 config and immutable v0.1 image. Never run v0.1 against the migrated database.

## Troubleshooting and development

Check local `/api/health`, mount permissions, mapping tests, Jobs and Needs Attention. Wait 30 seconds after a runtime crash before starting another instance. Inspect saved integration test errors; keys are write-only. Unknown metadata is a review outcome, not proof of wrong audio. Health checks do not contact Arr.

Use Node 20+ and ffmpeg. Run `npm ci`, `npm run typecheck`, `npm run lint -- --max-warnings=0`, `npm test`, `npm run audit`, `npm run secrets`, `git diff --check`, and `MG_BUILD=1 npm run build`. Tests use temporary databases, generated media and mocks. Build `docker build -t hh-media-guard:dev-gate .`, then `bash scripts/browser-gate.sh` for production browser, health, non-root, startup-key rejection, shutdown and persistent restart tests. The gate creates and removes its own Docker volumes and internal network. Do not substitute live service URLs or real media.

CI runs validation on pushes and pull requests. Release runs the gates again on annotated semantic version tags, checks package version, builds/publishes GHCR semantic tags and creates the GitHub Release. Release only after the authoritative `V0.2.0-TODO.md` gates pass; verify remote workflow conclusions, GitHub Release and registry manifests afterward. Published v0.1 tags/images must remain unchanged.
