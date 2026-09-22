# Safety-commit repair review

Scope: all files changed by `a1f7886` on `codex-wip-backup`, including deleted webhook glue, Docker/Compose, browser fixtures, login/quarantine UI, health/startup, Arr clients/transport, encryption, detector, durable queue, maintenance, retries, remediation, schema/types, webhooks and worker. Completed work was preserved. This review does not certify completion of the wider v0.2 release checklist.

## Corrections

- Moved IPv6 policy out of the IPv4 branch, canonicalized equivalent IPv6 spellings, and rejected mapped/transition/loopback/link-local addresses. Private LAN service addresses remain supported. DNS answers are checked and the selected answer pinned to the socket; redirects are not followed.
- Enforced canonical 32-byte base64 encryption keys at startup. Initialization failures explicitly exit rather than leaving Next's listener alive; error logs do not serialize configuration or untrusted exceptions.
- Quarantine moves pin both parent directories using Linux descriptors, reject symlink components, verify source/destination identity, and recheck authorization immediately before source unlink. Failed moves retain recoverable copies. Restores clear stale library action status.
- Added a database runtime ownership lease to prevent simultaneous startup recovery from interrupting another active runtime. Lost ownership fences mutations; normal shutdown drains the worker and releases ownership.
- Required exact Arr file/command identities and Sonarr replacement episode linkage. Policy-action failures now produce Needs Attention job outcomes rather than successful completion. Imported scans update library results; verified replacements clear stale action status.
- Bounded detector input/evidence, verified sample provenance and detector identity, and tested timeout/abort. No model is bundled, no real detector adapter is installed, and the worker remains metadata-only. The interface accepts bounded mono 16 kHz PCM16 samples from a future adapter; evidence never independently authorizes deletion.
- Browser tests wait for completed settings saves and queued-job acknowledgement before navigation. This fixed the quarantine workflow race without weakening assertions.
- Excluded environment files, database files and test artifacts from Docker context. Runtime media descriptors are excluded from build-time asset tracing. CI/release now use the isolated production browser/health gate with a fixture encryption key, instead of a smoke container that could not start without a key.

## Validation

Node 20 Alpine: formatting check, TypeScript, zero-warning ESLint, all unit/integration tests, dependency audit and repository secret scanner. Regression tests cover address aliases, detector failure/provenance, runtime fencing/recovery, quarantine directory swaps/identity mismatch/revoked authorization, and inconsistent Arr resources. Existing failed-job ownership, generated-media, webhook, authentication, migration and backup/restore tests remain enabled.

Production validation uses generated audio and mocked Arr services on an internal Docker network. Playwright exercises bootstrap/setup, settings, branding upload, mappings, scans/audit, library views, jobs/history/attention, Monitor Only's GET-only Arr guarantee, quarantine/restore, mobile navigation and login/logout. No live services or real media were accessed.

Final local results: 171 tests passed across 19 Vitest files; one production Playwright workflow passed (8.1 seconds total). Prettier, TypeScript, ESLint with zero warnings, secret scan, and dependency audit passed (zero vulnerabilities). Production Next.js/Docker builds passed without build warnings. Container health, non-root execution, invalid-key startup rejection, graceful shutdown, persistent-config restart, Compose validation, and packaged backup-module loading passed. Migration and backup/restore fixtures are included in the 171 tests. GitHub CI/release were not run remotely because pushing is prohibited for this task.

## Boundaries and remaining work

- Automatic remediation is tested against mocks, not live Sonarr/Radarr. Ambiguous identities, multi-title/pack downloads, incomplete history, conflicting Arr automatic-redownload configuration and uncertain external responses stop for attention. Uncertain mutations are never blindly repeated.
- Quarantine movement requires Linux `/proc`, explicit writable mounts, both safety gates and trusted administrator-controlled mount roots. Do not allow other untrusted processes to rename or alter media during remediation. It is not a defense against a hostile host administrator or concurrent arbitrary filesystem writers.
- No automatic quarantine-retention deletion is added. Recovery after partial external actions requires administrator inspection. Full retry/override UI and the broader release checklist remain separate work.
- The optional speech detector is an interface only, not operational AI support.
- No push, merge, rebase, main-branch change or release/tag publication is part of this repair. GitHub workflows can only be verified remotely after separate push authorization.
