# Docker

Use the compose file as a starting point. `/config` is writable and persistent; `/movies` and `/tv` should be `:ro` in Monitor Only. The image runs as an unprivileged `guard` user and includes ffprobe/ffmpeg. Back up `/config/media-guard.db` while the container is stopped, or copy its SQLite WAL companions too.
