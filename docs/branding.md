# Branding and Suite links

Settings → Appearance / Branding saves application, short and suite names, theme (dark/light/system), accent color, suite visibility, and Docker/Unraid icon URL metadata. The icon URL setting does not modify an already installed Unraid template.

Add, edit, disable or remove Suite application links, then Save appearance. Enabled links appear in the shell. Links accept HTTP(S) only and are browser navigation; the server does not fetch their targets. Link icons are short text/emoji. No Plex or Jellyfin connection is required.

Main logo, compact/header logo, favicon, and login artwork uploads accept PNG, JPEG, or WebP, at most 2 MiB and 4096 × 4096 pixels. Content must match MIME type; SVG, animation and invalid images are rejected. Uploads are decoded and re-encoded as PNG to discard metadata and trailing content. Original filenames are discarded in favor of random internal names. Assets persist in `/config/branding`; Reset removes the active slot and uses the default again. Prior images remain available for backups; only active slots are served. Branding values are escaped text, not HTML or CSS input.
