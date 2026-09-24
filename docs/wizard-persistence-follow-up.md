# Wizard and branding persistence follow-up (unreleased)

This continues the v0.2.2 stabilization work from `166a3bb`. No version/tag/release or registry alias changes are part of this follow-up. All tests use isolated containers, distinct mock Arr services and generated media; no production services or H&H Streaming were accessed.

## Findings

The reported HTTP 401 responses establish that the services were reachable. The supplied direct Radarr fetch had no API key, so that particular 401 is expected and does not independently establish a header-transmission defect. The Sonarr library 401 means its request reached an authentication boundary and was rejected; without exposing/inspecting live credentials we cannot prove which credential it contained.

Two reproducible persistence defects were found:

1. `SetupWizard` changed steps without invoking or awaiting the forms' save operations. Typed credentials and branding/policy changes could be discarded on unmount, and a user could leave during an in-flight save. Revisited forms also depended on older server-provided settings. The earlier production connection test skipped wizard entry and configured integrations in Settings, so it did not cover this workflow.
2. POST `/api/settings` evaluated `getSettings()` before `await jsonBody(request)`. A slower request could capture old branding, then overwrite a different request's completed save. Concurrent-request regression tests cover setup completion versus branding, and language-policy versus suite/theme updates.

No separate AES encryption, decryption or X-Api-Key construction defect was reproduced. Rather than modify those working security boundaries, the new production tests prove their use through the actual wizard and library worker with different required keys for Sonarr and Radarr.

## Fixes

- Wizard Continue and Back invoke the current forms' normal save functions, await success, then fetch authoritative settings before changing steps. Finish still writes only setupComplete.
- Validation or save failures keep the user on the current step and retain input, including a newly entered API key. Navigation is guarded against duplicate clicks; forms cannot be edited while their requests are running.
- Every step mounts separately. Integration fetches ignore results after unmount. Revisiting a step and partially reloading the wizard preserve already-saved settings and credentials; saved password fields intentionally remain blank.
- Optional, untouched integrations may be skipped without writing blank configuration. Test Connection remains read-only and does not implicitly persist a new credential.
- The settings API parses the request body before reading current settings and performs merge/validation/write without another asynchronous gap.
- Branding retains names, theme, accent, suite visibility/links, and all three customizable image slots. The fox favicon and Unraid icon remain fixed.
- Path mappings still use explicit Add/Update. Drafts that have never been saved with Save/Continue/Back are not stored in browser storage and will not survive closing/reloading the page. This avoids retaining plaintext keys in local/session storage.

## Production regression coverage

The Unraid gate now fills the wizard instead of bypassing it:

- Branding names/theme/accent/suite visibility/links, image uploads, Back navigation, partial-wizard reload and completed-setup reload.
- Injected failed branding and credential saves retain the form and cannot advance. A delayed real save keeps navigation disabled until the response arrives.
- Sonarr and Radarr tests before persistence, Continue without pressing Save, Back navigation, saved-key tests and the final connection-test step.
- Separate mock services require their distinct exact plaintext keys through X-Api-Key for both status and library endpoints; no stubbed transport or unconditional success is used.
- The UI queues one real library audit per service. The production worker decrypts saved keys, enumerates series/episodes/files or movies/files, resolves wizard-created mappings, and inspects generated English audio under read-only `/Media`.
- Both jobs complete with one processed item and passing media results, on fresh setup, restart, recreation and original-key restoration. Wrong-key connection tests still fail safely.
- Existing database/history/retry/branding persistence, non-root/capability checks, media ownership protection, template checks, secret redaction, fixed-icon checks and security gates remain enabled.

## Upgrade implications

No additional variable or schema migration is required. Keep the existing encryption key, configuration mount and media roots. Previously discarded or incorrect credentials cannot be recovered automatically: re-enter and save valid keys in the fixed wizard or Settings when the approved release is eventually installed. No changes to the live installation were made as part of this investigation.

## Changed files

- `src/components/SetupPersistence.tsx`, `SetupWizard.tsx`: navigation/save coordination.
- `src/components/IntegrationSettings.tsx`, `AppearanceSettings.tsx`, `PolicySettings.tsx`: shared save operations and pending-operation controls.
- `src/app/globals.css`: preserve form appearance while disabling pending controls.
- `src/app/api/settings/route.ts`: concurrent settings merge fix.
- `tests/settings-persistence.test.ts`, `vitest.config.mts`: real route concurrency regressions and test import alias resolution.
- `tests/e2e/wizard-flow.ts`, `unraid.spec.ts`, `connection-fixture.mjs`, `scripts/unraid-gate.sh`: complete wizard and authenticated library/restart coverage.
- `docs/setup.md`, `docs/branding.md`, `docs/v0.2.2-stabilization.md`, this report and `CHANGELOG.md`: behavior, diagnostics and planned release documentation.

## Verification results

- Formatting, typecheck and zero-warning lint passed.
- 231 unit tests across 23 files passed, including two concurrent settings-save regressions.
- Dependency audit reported zero vulnerabilities; secret scan, diff checks, template validation, Compose validation and actionlint passed.
- Production Next.js and Docker builds passed.
- All six production browser executions passed: the existing administration workflow plus fresh wizard setup, restart, recreation, wrong-key failure and restored-key recovery.
- Eight authenticated library audits (both services in each successful lifecycle phase) completed with one processed, passing generated media item each.
- Existing startup diagnostics, non-root PID 1, health, config persistence, media read-only/ownership and symlink/hardlink/mount-boundary checks passed.
- No live connectivity claim is made: the evidence is from the exact production UI/API/worker paths against isolated strict-key mock services.
