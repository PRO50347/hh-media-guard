"use client";
import { useState } from "react";
import { Settings } from "@/lib/types";
import { api, json } from "./api";
export function PolicySettings({
  initial,
  destructiveEnabled,
}: {
  initial: Settings;
  destructiveEnabled: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [languages, setLanguages] = useState(
    initial.requiredLanguages.join(","),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="card">
      <h2>Language policy and safety</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(
              "/api/settings",
              json("POST", {
                requiredLanguages: languages
                  .split(",")
                  .map((v) => v.trim().toLowerCase()),
                allowDescriptive: value.allowDescriptive,
                safetyMode: value.safetyMode,
                retryLimit: value.retryLimit,
                retryCooldownMinutes: value.retryCooldownMinutes,
                quarantinePath: value.quarantinePath,
              }),
            );
            setMessage("Policy saved");
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Required language codes (comma separated)
          <input
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
            required
          />
          <small>
            Example: eng, fra. At least one matching main-program track is
            required.
          </small>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.allowDescriptive}
            onChange={(e) =>
              setValue({ ...value, allowDescriptive: e.target.checked })
            }
          />
          Accept descriptive audio
        </label>
        <p className="muted">
          Commentary and short bonus tracks are excluded. Unknown metadata
          always needs analysis.
        </p>
        <label>
          Operating mode
          <select
            value={value.safetyMode}
            onChange={(e) =>
              setValue({
                ...value,
                safetyMode: e.target.value as Settings["safetyMode"],
              })
            }
          >
            <option value="monitor">Monitor Only</option>
            <option value="quarantine" disabled={!destructiveEnabled}>
              Quarantine
            </option>
            <option value="automatic" disabled={!destructiveEnabled}>
              Automatic
            </option>
          </select>
        </label>
        <p>
          Environment kill switch:{" "}
          {destructiveEnabled
            ? "enabled"
            : "OFF — filesystem and Arr mutations prohibited"}
          .
        </p>
        {value.safetyMode !== "monitor" && (
          <p className="notice">
            This mode can change media and external services. Use writable test
            fixtures until you have reviewed the safety documentation.
          </p>
        )}
        <label>
          Quarantine directory
          <input
            value={value.quarantinePath || ""}
            onChange={(e) =>
              setValue({ ...value, quarantinePath: e.target.value })
            }
          />
        </label>
        <div className="form-grid">
          <label>
            Maximum replacement attempts
            <input
              type="number"
              min={1}
              max={10}
              value={value.retryLimit}
              onChange={(e) =>
                setValue({ ...value, retryLimit: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Retry cooldown (minutes)
            <input
              type="number"
              min={1}
              max={10080}
              value={value.retryCooldownMinutes}
              onChange={(e) =>
                setValue({
                  ...value,
                  retryCooldownMinutes: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <button disabled={busy} type="submit">
          Save language and safety policy
        </button>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}
