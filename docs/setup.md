# Setup and path mappings

Start with Monitor Only and read-only media mounts. Set a persistent `/config`, a canonical 32-byte base64 `ENCRYPTION_KEY` (`openssl rand -base64 32`), and `APP_URL` to the exact browser origin, including scheme and port. Open that URL, create the local administrator, and complete the setup wizard. Configure integrations and paths in Settings afterward; neither Sonarr nor Radarr is mandatory.

Enter each integration's base URL and API key, then Test connection before saving. Tests use the current form values without persisting them. After Save/reload a blank API-key field uses the decrypted existing key. Remove clears the integration credentials. See [Unraid networking and setup](unraid.md) for bridge-mode addresses, URL bases and diagnostic guidance.

`MEDIA_ROOTS` is the comma-separated administrator-approved list of container roots (Compose uses `/movies,/tv`). In Settings → Path mappings, map the Arr-visible directory, such as `/data/tv`, to the existing container directory `/tv`. Select Sonarr, Radarr, or generic, choose a media type, and Test mapping before saving. Editing allows disabling a mapping without deleting it. Removing a mapping does not move files. The longest enabled source prefix wins; paths must stay inside approved roots and cannot contain traversal or symlinks escaping those roots.

Library queues entire-library, integration, series, season (including season 0), movie, individual-file, and failed/unknown rescan jobs. A Sonarr series ID is not an episode ID. Movies and TV Shows display discovered files, search/status filters, decisions, and rescan controls. Jobs shows progress and cancellation. History retains scan evidence. Needs Attention separates open, accepted, and ignored records, including evidence and manual controls.

Language policy requires at least one usable main-program track in the configured languages. Commentary is always excluded; descriptive audio is optional. Unknown metadata remains Needs analysis. Quarantine and Automatic require both the UI mode and `ALLOW_DESTRUCTIVE_ACTIONS=true`; Compose deliberately keeps the environment switch false. See [operations](operations.md) before changing it.
