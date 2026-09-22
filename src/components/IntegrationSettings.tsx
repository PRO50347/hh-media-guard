"use client";
import { useEffect, useState } from "react";
import { api, json } from "./api";
import { WebhookSettings } from "./WebhookSettings";
type Config = {
  enabled: boolean;
  url?: string;
  apiKeyConfigured: boolean;
  version?: string;
  lastError?: string;
  lastTestedAt?: string;
};
export function IntegrationSettings({ id }: { id: "sonarr" | "radarr" }) {
  const [config, setConfig] = useState<Config>();
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Config>(`/api/integrations/${id}`)
      .then(setConfig)
      .catch((e) => setMessage(e.message));
  }, [id]);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await task();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!config)
    return (
      <section className="card">
        <h2>{id}</h2>
        <p role="status">{message || "Loading integration…"}</p>
      </section>
    );
  return (
    <section className="card">
      <h2>{id === "sonarr" ? "Sonarr" : "Radarr"}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setConfig(
              await api<Config>(
                `/api/integrations/${id}`,
                json("PUT", {
                  enabled: config.enabled,
                  url: config.url || undefined,
                  apiKey: apiKey || undefined,
                }),
              ),
            );
            setApiKey("");
            setMessage(
              "Saved. Stored API keys are never returned to the browser.",
            );
          });
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) =>
              setConfig({ ...config, enabled: e.target.checked })
            }
          />
          Enabled
        </label>
        <label>
          Server URL
          <input
            type="url"
            value={config.url || ""}
            onChange={(e) => setConfig({ ...config, url: e.target.value })}
          />
        </label>
        <label>
          API key{" "}
          <small>
            {config.apiKeyConfigured
              ? "Configured — leave blank to keep"
              : "Not configured"}
          </small>
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <div className="actions">
          <button disabled={busy} type="submit">
            Save {id}
          </button>
          <button
            disabled={busy || !config.apiKeyConfigured}
            type="button"
            onClick={() =>
              void run(async () => {
                const result = await api<{ version: string }>(
                  `/api/integrations/${id}`,
                  { method: "POST" },
                );
                setConfig(await api<Config>(`/api/integrations/${id}`));
                setMessage(`Connected: ${result.version}`);
              })
            }
          >
            Test connection
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                confirm(`Remove saved ${id} credentials? No media is changed.`)
              )
                void run(async () => {
                  await api(`/api/integrations/${id}`, { method: "DELETE" });
                  setConfig({ enabled: false, apiKeyConfigured: false });
                  setMessage("Integration removed");
                });
            }}
          >
            Remove
          </button>
        </div>
      </form>
      {config.version && <p>Detected version: {config.version}</p>}
      {config.lastTestedAt && (
        <p className="muted">
          Last test: {new Date(config.lastTestedAt).toLocaleString()}
        </p>
      )}
      {config.lastError && <p className="error">{config.lastError}</p>}
      <p role="status">{message}</p>
      <WebhookSettings source={id} />
    </section>
  );
}
