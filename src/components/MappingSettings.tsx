"use client";
import { useEffect, useState } from "react";
import { PathMapping } from "@/lib/types";
import { api, json } from "./api";
const blank: Omit<PathMapping, "id"> = {
  source: "generic",
  arrPath: "",
  containerPath: "",
  mediaType: "other",
  enabled: true,
};
export function MappingSettings() {
  const [items, setItems] = useState<PathMapping[]>([]);
  const [form, setForm] = useState<Omit<PathMapping, "id"> & { id?: string }>(
    blank,
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setItems(await api<PathMapping[]>("/api/mappings"));
  }
  useEffect(() => {
    api<PathMapping[]>("/api/mappings")
      .then(setItems)
      .catch((e) => setMessage(e.message));
  }, []);
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
  return (
    <section className="card">
      <h2>Path mappings</h2>
      <p className="muted">
        Map Arr paths to existing container directories approved by MEDIA_ROOTS.
        No file is modified by testing a mapping.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Arr path</th>
              <th>Container path</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.source}</td>
                <td>{item.arrPath}</td>
                <td>{item.containerPath}</td>
                <td>{item.enabled ? "Enabled" : "Disabled"}</td>
                <td>
                  <button onClick={() => setForm(item)}>Edit</button>{" "}
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          "Remove this mapping? Existing media will not be modified.",
                        )
                      )
                        void run(async () => {
                          await api(`/api/mappings?id=${item.id}`, {
                            method: "DELETE",
                          });
                          await refresh();
                          setMessage("Mapping removed");
                        });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <p>No mappings configured.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/mappings", json(form.id ? "PUT" : "POST", form));
            await refresh();
            setForm(blank);
            setMessage("Mapping saved");
          });
        }}
      >
        <div className="form-grid">
          <label>
            Source
            <select
              value={form.source}
              onChange={(e) =>
                setForm({
                  ...form,
                  source: e.target.value as PathMapping["source"],
                })
              }
            >
              {["generic", "sonarr", "radarr"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Media type
            <select
              value={form.mediaType}
              onChange={(e) =>
                setForm({
                  ...form,
                  mediaType: e.target.value as PathMapping["mediaType"],
                })
              }
            >
              {["tv", "movies", "anime", "kids", "other"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Arr-visible path
            <input
              required
              placeholder="/data/tv"
              value={form.arrPath}
              onChange={(e) => setForm({ ...form, arrPath: e.target.value })}
            />
          </label>
          <label>
            Container-visible path
            <input
              required
              placeholder="/tv"
              value={form.containerPath}
              onChange={(e) =>
                setForm({ ...form, containerPath: e.target.value })
              }
            />
          </label>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <div className="actions">
          <button disabled={busy} type="submit">
            {form.id ? "Update mapping" : "Add mapping"}
          </button>
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void run(async () => {
                await api("/api/mappings?test=true", json("POST", form));
                setMessage(
                  "Mapping resolves safely within an approved media root",
                );
              })
            }
          >
            Test mapping
          </button>
          {form.id && (
            <button type="button" onClick={() => setForm(blank)}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}
