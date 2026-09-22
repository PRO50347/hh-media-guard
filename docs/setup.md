# Setup and path mappings

Complete the wizard, then configure mapping roots before scanning. A mapping translates an Arr path such as `/data/tv` to a container mount such as `/tv`; multiple TV, Movies, anime, and kids roots are supported by `MEDIA_ROOTS` initially (comma-separated). Webhook file paths are untrusted and must resolve under a configured root. Never mount `/` or unrelated host directories.
