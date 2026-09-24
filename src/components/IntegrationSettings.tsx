"use client";
import { useEffect, useRef, useState } from "react";
import { useSetupSave } from "./SetupPersistence";
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
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    let active = true;
    api<Config>(`/api/integrations/${id}`)
      .then((data) => {
        if (active) setConfig(data);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await task();
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!config) {
      // No editable form is mounted yet. Verify the saved state can be read;
      // advancing an untouched optional step must never write blank values.
      return run(async () => {
        await api<Config>(`/api/integrations/${id}`);
      });
    }
    if (!config.enabled && !config.url && !apiKey && !config.apiKeyConfigured)
      return true;
    return run(async () => {
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
      setMessage("Saved. Stored API keys are never returned to the browser.");
    });
  }
  useSetupSave(form, busy, save);
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
      <p className="muted">
        Use your server LAN address and mapped port (Sonarr:
        http://SERVER-IP:8989; Radarr: http://SERVER-IP:7878), or a container
        name on a shared custom Docker network. localhost refers to Media Guard
        itself. Include any configured URL base, such as /sonarr. Test before
        saving; blank API key uses the saved key.
      </p>
      <form
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="save-controls" disabled={busy}>
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
              disabled={
                busy || !config.url || (!apiKey && !config.apiKeyConfigured)
              }
              type="button"
              onClick={() =>
                void run(async () => {
                  const result = await api<{ version: string }>(
                    `/api/integrations/${id}`,
                    json("POST", {
                      url: config.url,
                      apiKey: apiKey || undefined,
                    }),
                  );
                  setConfig({
                    ...config,
                    version: result.version,
                    lastError: undefined,
                  });
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
                  confirm(
                    `Remove saved ${id} credentials? No media is changed.`,
                  )
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
        </fieldset>
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
