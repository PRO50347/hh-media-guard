# Sonarr, Radarr, and webhooks

Both integrations are optional. Connection tests only request `/api/v3/system/status` with the API key and use an 8-second timeout. API keys are write-only by design. Webhooks require `WEBHOOK_SECRET` and an `X-Media-Guard-Signature: sha256=<HMAC-SHA256 body>` header. Intake records a safe audit event only; imported paths must subsequently pass mapping validation. Do not expose the webhook endpoint directly to the internet without a reverse proxy/authentication layer.
