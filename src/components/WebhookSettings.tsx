"use client";
import { useState } from "react";
import { api } from "./api";
export function WebhookSettings({ source }: { source: "sonarr" | "radarr" }) {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  return (
    <details>
      <summary>{source} webhook configuration</summary>
      <p>
        In {source} → Settings → Connect, add a Webhook. Enable On Import / On
        Upgrade, use POST, and set the URL to your Media Guard browser URL
        followed by <code>/api/webhooks/{source}</code>. Enable advanced
        settings and add the header below.
      </p>
      <p>
        Generating a token revokes the previous token immediately. Store it in
        Arr; Media Guard will not show it again.
      </p>
      <button
        type="button"
        onClick={async () => {
          if (
            !confirm(
              `Generate a new ${source} webhook token and revoke the previous token?`,
            )
          )
            return;
          try {
            const data = await api<{ token: string }>(
              `/api/integrations/${source}/webhook`,
              { method: "POST" },
            );
            setToken(data.token);
            setMessage("Token generated. Copy it now.");
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        Generate / rotate token
      </button>
      {token && <pre>Authorization: Bearer {token}</pre>}
      <p role="status">{message}</p>
    </details>
  );
}
