"use client";
import { useState } from "react";
import { api, json } from "./api";
type Item = {
  id: string;
  source: string;
  arr_id: number;
  title: string;
  path: string;
  decision?: string;
  last_scanned_at?: string;
  action_state: string;
  details?: string;
};
export function MediaView({ items }: { items: Item[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState("");
  const shown = items.filter(
    (item) =>
      `${item.title} ${item.path}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!filter || item.decision === filter || item.action_state === filter),
  );
  async function rescan(rows: Item[]) {
    try {
      for (const item of rows) {
        const details = item.details ? JSON.parse(item.details) : {};
        await api(
          "/api/jobs",
          json("POST", {
            kind: "scan-library",
            source: item.source,
            entityId: item.arr_id,
            seriesId: details.seriesId,
            force: true,
          }),
        );
      }
      setMessage(`${rows.length} scan jobs queued`);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <section className="card">
      <div className="form-grid">
        <label>
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Status
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="pass">Verified</option>
            <option value="fail">Wrong language</option>
            <option value="needs-analysis">Needs analysis</option>
            <option value="needs-attention">Needs attention</option>
            <option value="pending">Pending replacement</option>
            <option value="quarantined">Quarantined</option>
          </select>
        </label>
      </div>
      <button disabled={!shown.length} onClick={() => void rescan(shown)}>
        Rescan displayed media ({shown.length})
      </button>
      <p role="status">{message}</p>
      {shown.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>File</th>
                <th>Policy result</th>
                <th>Last scan</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    <small>
                      <br />
                      {item.source} #{item.arr_id}
                    </small>
                  </td>
                  <td>{item.path}</td>
                  <td>
                    <span className={"badge " + item.decision}>
                      {item.decision || "Not scanned"}
                    </span>
                  </td>
                  <td>{item.last_scanned_at || "—"}</td>
                  <td>
                    {item.action_state}
                    <br />
                    <button onClick={() => void rescan([item])}>Rescan</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">
          No matching media. Start a library audit to discover mapped files.
        </p>
      )}
    </section>
  );
}
