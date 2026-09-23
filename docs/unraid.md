# Unraid

Import `unraid/hh-media-guard.xml` as a local Docker template; availability in a public Community Applications catalog is not assumed. Set a persistent appdata path for `/config`, exact browser `APP_URL`, and a newly generated 32-byte base64 `ENCRYPTION_KEY`. Keep the key securely outside appdata backups as well. Verify the image's `guard` UID/GID has write permission to appdata; do not use broad world-writable permissions.

Map TV and movie roots read-only initially, set corresponding container paths in `MEDIA_ROOTS`, and keep `ALLOW_DESTRUCTIVE_ACTIONS=false`. Visit the WebUI, create the administrator and finish setup, then save/test Arr integrations and mappings. Arr-visible and container-visible paths may differ.

For a deliberate later move to Quarantine/Automatic, review [operations](operations.md), supply a writable quarantine mount outside scanned roots, make only the required media mounts writable, and enable both the environment switch and UI mode. No live Unraid testing is part of this release validation. Back up configuration, encryption key and quarantine storage before upgrading. Restore the pre-upgrade config when rolling back to v0.1.
