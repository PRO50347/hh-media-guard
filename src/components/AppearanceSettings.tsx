"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "@/lib/types";
import { api, json } from "./api";
export function AppearanceSettings({ initial }: { initial: Settings }) {
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
      setMessage("Appearance updated");
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const links = value.suiteLinks || [];
  return (
    <section className="card">
      <h2>Appearance / Branding</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            api(
              "/api/settings",
              json("POST", {
                appName: value.appName,
                suiteName: value.suiteName,
                shortName: value.shortName,
                accent: value.accent,
                theme: value.theme,
                showSuite: value.showSuite,
                suiteLinks: links,
              }),
            ),
          );
        }}
      >
        <div className="form-grid">
          {(["appName", "suiteName", "shortName"] as const).map((key, i) => (
            <label key={key}>
              {["Application name", "Suite name", "Short name"][i]}
              <input
                value={value[key]}
                required={key !== "suiteName"}
                maxLength={key === "shortName" ? 40 : 80}
                onChange={(e) => setValue({ ...value, [key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            Accent
            <input
              type="color"
              value={value.accent}
              onChange={(e) => setValue({ ...value, accent: e.target.value })}
            />
          </label>
          <label>
            Theme
            <select
              value={value.theme}
              onChange={(e) =>
                setValue({
                  ...value,
                  theme: e.target.value as Settings["theme"],
                })
              }
            >
              {["dark", "light", "system"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.showSuite}
            onChange={(e) =>
              setValue({ ...value, showSuite: e.target.checked })
            }
          />
          Show suite branding
        </label>
        <h3>Suite application links</h3>
        {links.map((link, index) => (
          <fieldset key={index}>
            <legend>Application {index + 1}</legend>
            <div className="form-grid">
              {(["name", "url", "icon"] as const).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    type={key === "url" ? "url" : "text"}
                    value={link[key]}
                    required
                    onChange={(e) =>
                      setValue({
                        ...value,
                        suiteLinks: links.map((item, i) =>
                          i === index
                            ? { ...item, [key]: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={link.enabled}
                onChange={(e) =>
                  setValue({
                    ...value,
                    suiteLinks: links.map((item, i) =>
                      i === index
                        ? { ...item, enabled: e.target.checked }
                        : item,
                    ),
                  })
                }
              />
              Enabled
            </label>
            <button
              type="button"
              onClick={() =>
                setValue({
                  ...value,
                  suiteLinks: links.filter((_, i) => i !== index),
                })
              }
            >
              Remove link
            </button>
          </fieldset>
        ))}
        <div className="actions">
          <button
            type="button"
            disabled={links.length >= 20}
            onClick={() =>
              setValue({
                ...value,
                suiteLinks: [
                  ...links,
                  { name: "", url: "", icon: "↗", enabled: true },
                ],
              })
            }
          >
            Add suite link
          </button>
          <button disabled={busy} type="submit">
            Save appearance
          </button>
        </div>
      </form>
      <p className="muted">
        The browser favicon and Docker/Unraid app icon use the builder-managed
        H&H fox logo. All other branding below remains customizable.
      </p>
      <h3>Persistent images</h3>
      <p className="muted">
        PNG, JPEG or WebP; maximum 2 MiB and 4096 × 4096 pixels. SVG and
        animated files are not accepted. Images persist under /config/branding.
      </p>
      <div className="form-grid">
        {(["logo", "compact", "background"] as const).map((kind, index) => (
          <div key={kind}>
            <label>
              {["Main logo", "Compact / header logo", "Login artwork"][index]}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void run(() =>
                      api(`/api/branding/${kind}`, {
                        method: "PUT",
                        headers: { "content-type": file.type },
                        body: file,
                      }),
                    );
                  e.target.value = "";
                }}
              />
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`/api/branding/${kind}`, { method: "DELETE" }),
                )
              }
            >
              Reset {kind}
            </button>
          </div>
        ))}
      </div>
      <p role="status">{message}</p>
    </section>
  );
}
