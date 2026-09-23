# Architecture

Next.js supplies authenticated administration and API routes. SQLite at `/config/media-guard.db` stores settings, encrypted credentials, hashed sessions/webhook tokens, mappings, media records, scan evidence, jobs, retry budgets, operation journals and additive migrations. A runtime lease prevents two instances from owning recovery on the same database.

Library audits enumerate Arr identities and map paths into approved local roots. Import webhooks atomically record a receipt and enqueue file inspection. The single worker leases one job at a time, heartbeats ownership and cancellation, invokes bounded ffprobe, normalizes language metadata, applies policy and saves evidence. Fingerprints include path, stat data and language policy; unchanged files reuse scan evidence unless a forced rescan is requested. Optional periodic audits use persisted schedule state.

Monitor Only ends with persisted results. Quarantine uses verified local evidence and durable file-movement records. Automatic requires matching Arr identity/history plus a retry reservation, then journals quarantine, reconciliation, rejection and search steps before dispatch. An uncertain mutation is not replayed. A later passing scan with new verified Arr identity completes pending replacement. The administrator can review evidence, pause/reset title budgets, queue audits or restore quarantined media; overrides preserve the original scan and operation records.

Settings and image assets are persisted under `/config`. Branding image normalization strips metadata, while the public asset route serves only active named slots. The detector module defines a future bounded sample adapter contract; production inspection remains metadata-only and never invokes an AI service.
