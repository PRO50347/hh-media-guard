"use client";
import { useState } from "react";
import Link from "next/link";
import { api, json } from "./api";
export function ScanControls() {
  const [path, setPath] = useState("");
  const [source, setSource] = useState("");
  const [entity, setEntity] = useState("");
  const [season, setSeason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function queue(payload: unknown) {
    setBusy(true);
    try {
      const result = await api<{ id: string }>(
        "/api/jobs",
        json("POST", payload),
      );
      setMessage(`Queued job ${result.id}`);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card">
        <h2>Library audit</h2>
        <p>
          Enumerate enabled integrations and inspect mapped files. Unchanged
          media is skipped using file size, modification time, path, and policy.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void queue({
              kind: "scan-library",
              source: source || undefined,
              entityId: entity ? Number(entity) : undefined,
              seriesId:
                source === "sonarr" && entity ? Number(entity) : undefined,
              season: season ? Number(season) : undefined,
            });
          }}
        >
          <div className="form-grid">
            <label>
              Integration
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Entire library</option>
                <option value="sonarr">Sonarr</option>
                <option value="radarr">Radarr</option>
              </select>
            </label>
            <label>
              Series / movie ID (optional)
              <input
                type="number"
                min={1}
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
              />
            </label>
            {source === "sonarr" && (
              <label>
                Season (optional)
                <input
                  type="number"
                  min={0}
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="actions">
            <button disabled={busy}>Start library audit</button>
            <button
              disabled={busy}
              type="button"
              onClick={() =>
                void queue({
                  kind: "scan-library",
                  filter: "fail",
                  force: true,
                })
              }
            >
              Rescan wrong language
            </button>
            <button
              disabled={busy}
              type="button"
              onClick={() =>
                void queue({
                  kind: "scan-library",
                  filter: "needs-analysis",
                  force: true,
                })
              }
            >
              Rescan unknown
            </button>
          </div>
        </form>
      </section>
      <section className="card">
        <h2>Scan individual file</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void queue({ kind: "scan-file", path, force: true });
          }}
        >
          <label>
            Container-visible media path
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
              placeholder="/tv/example.mkv"
            />
          </label>
          <button disabled={busy}>Queue file scan</button>
        </form>
      </section>
      <p role="status">{message}</p>
      <Link href="/jobs">View jobs and progress →</Link>
    </>
  );
}
