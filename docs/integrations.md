# Sonarr, Radarr, and webhooks

Configure optional Sonarr/Radarr base URLs (HTTP or HTTPS, including any reverse-proxy path prefix) and API keys under Settings. Tests use `/api/v3/system/status` and only read saved settings. Keys are encrypted under `/config` and never returned by the settings API. HTTP uses the trusted LAN; HTTPS is preferable across untrusted networks. Loopback, link-local, metadata-service addresses, redirects, credentials in URLs, and prohibited DNS results are rejected. Private LAN addresses remain supported. Each DNS answer is checked and the chosen address is pinned for the request; requests time out after eight seconds.

Library audits use Sonarr series/episode/episode-file joins and Radarr movie/movie-file resources. Missing or inconsistent identity cannot authorize remediation. Multiple-episode files and ambiguous release/pack history require manual attention in Automatic mode.

## Import notifications

In Media Guard Settings, expand the integration's webhook configuration and Generate / rotate token. Copy the shown token; only its hash is stored and rotation immediately invalidates the previous token. In Arr Settings → Connect, add a Webhook with POST, On Import / On Upgrade, URL `APP_URL/api/webhooks/sonarr` or `APP_URL/api/webhooks/radarr`, and advanced header `Authorization: Bearer TOKEN`. Arr's Test notification is supported. Use the URL reachable from Arr, with HTTPS on untrusted networks.

The native receiver uses per-integration bearer tokens, not `WEBHOOK_SECRET` or an HMAC header. Authenticated Download events commit a replay receipt and durable scan job in one transaction. Duplicate import identities do not enqueue a second job. Body size is bounded to 256 KiB. File paths must pass configured mappings and media-root validation before inspection. Do not publish tokens in URLs or logs.

## Automatic replacement contract

Automatic mode is validated against isolated contract mocks, not live services. It requires unambiguous current file identity, a failed persisted scan, and matching imported/grabbed history. Disable Arr's automatic failed-download redownload so Media Guard owns the search budget. The workflow quarantines the failed file, requests RescanSeries/RescanMovie, waits for reconciliation and checks the original file is absent, marks the identified grabbed history failed through `/api/v3/history/failed/{id}`, then issues EpisodeSearch/MoviesSearch once. This uses Arr's supported failed-history rejection/blocklisting path; Media Guard does not invent a direct blocklist insertion API or delete a possibly replaced file through Arr.

Every uncertain external outcome stops in Needs Attention. A later import notification or audit verifies a replacement only with a different Arr file ID, current mapping/identity, and fresh persisted passing evidence. A search being accepted is not a verified replacement. If an Arr version rejects these API contracts, retain the quarantined file and inspect the operation rather than replaying mutations.
