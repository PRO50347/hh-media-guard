# Branding and Suite links

Settings → Appearance / Branding saves application, short and suite names, theme (dark/light/system), accent color and suite visibility. Users can still customize the main UI logo, compact/header logo and login/background artwork independently of the fixed app icons.

Add, edit, disable or remove Suite application links, then Save appearance. Enabled links appear in the shell. Links accept HTTP(S) only and are browser navigation; the server does not fetch their targets. Link icons are short text/emoji. No Plex or Jellyfin connection is required.

Main UI logo, compact/header logo and login artwork uploads accept PNG, JPEG, or WebP, at most 2 MiB and 4096 × 4096 pixels. Content must match MIME type; SVG, animation and invalid images are rejected. Uploads are decoded and re-encoded as PNG to discard metadata and trailing content. Original filenames are discarded in favor of random internal names. Assets persist in `/config/branding`; Reset removes the active slot and uses the default again. Prior images remain available for backups; only active customizable slots are served. Branding values are escaped text, not HTML or CSS input.

## Builder-managed favicon and Docker/Unraid icon

Only these two icons are fixed: the browser tab favicon and the Docker/Unraid application icon. Both use `public/branding/fox-logo.png`, packaged in the image and served at `/branding/fox-logo.png`. The browser metadata always references that file. The Unraid template references the same asset through `https://raw.githubusercontent.com/PRO50347/hh-media-guard/main/public/branding/fox-logo.png`.

The source is a byte-for-byte copy of H&H Streaming's original 1024 × 1024 `public/branding/hh-streaming-logo-master.png`; no logo was generated, resized or redrawn. H&H Streaming was inspected read-only and left unchanged.

To change these icons, the owner/builder replaces `public/branding/fox-logo.png` in this repository and rebuilds the Media Guard image. Keep the same filename; no icon-generation step or app setting is needed. For Unraid's public URL, publish the replacement asset to the corresponding repository/branch (builders using a fork should update the template URL). Existing Unraid installations may need their template icon refreshed, and browsers may cache the old icon.

There is no favicon uploader/reset or Docker icon URL control. The branding API rejects the retired favicon slot, and the settings API rejects `iconUrl` writes. Old favicon upload records and icon URL preferences cannot override the fixed asset; older files can remain in backups without being served as the app favicon. All other branding controls listed above remain user-customizable.

In the setup wizard, Continue and Back save the current appearance fields before navigating. Returning to Branding reloads the saved names, theme, accent, suite visibility and links. Failed saves retain the form; uploads save immediately and must finish before navigation. Outside the wizard, use Save appearance as before.
