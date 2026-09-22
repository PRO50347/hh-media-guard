# Operations

## Security and privacy

URLs, payloads, filenames, metadata, and branding uploads are untrusted. Service URLs reject local loopback inputs, paths use canonical resolution beneath roots, and ffprobe uses argument arrays. Avoid logging API keys. Run behind your normal authenticated reverse proxy. No media is uploaded or sent to a cloud service.

## Backup / restore

Stop the container, copy `/config`, restore it to a replacement `/config`, and restart. Settings and history are portable SQLite data.

## Troubleshooting

Check `/api/health`, ensure mounts are readable by the container user, confirm a path begins with a configured root, and inspect container logs for ffprobe errors. Unknown metadata is expected for some files and should be reviewed, not treated as proof of wrong audio.

## Development / release

Run `npm ci && npm run typecheck && npm run lint && npm test && npm run build`. The release workflow runs on semantic `v*` tags and publishes immutable GHCR tags plus `latest`.
