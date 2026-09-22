# Operations

## Security and privacy

URLs, payloads, filenames, metadata, and branding uploads are untrusted. Service URLs reject local loopback inputs, paths use canonical resolution beneath roots, and ffprobe uses argument arrays. Avoid logging API keys. Run behind your normal authenticated reverse proxy. No media is uploaded or sent to a cloud service.

## Backup / restore

Stop the container, copy `/config`, restore it to a replacement `/config`, and restart. Settings and history are portable SQLite data.

## Troubleshooting

Check `/api/health`, ensure mounts are readable by the container user, confirm a path begins with a configured root, and inspect container logs for ffprobe errors. Unknown metadata is expected for some files and should be reviewed, not treated as proof of wrong audio.

## Development / release

Use Node 20+ with ffmpeg installed. Run `npm ci`, `npm run typecheck`, `npm run lint -- --max-warnings=0`, `npm test`, and `MG_BUILD=1 npm run build`. `MG_BUILD` skips runtime initialization only during compilation; never set it on a running deployment. Runtime startup requires a valid `ENCRYPTION_KEY` and exact `APP_URL` origin. Build `docker build -t hh-media-guard:dev-gate .` and run `bash scripts/browser-gate.sh` for the isolated production browser/health gate. The script uses generated media and an internal Docker mock network, not live Arr services. Release workflows run these checks before publishing semantic tags; no release was authorized by the interrupted-work repair task.
