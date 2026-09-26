"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { api, json } from "./api";
import { RemediationAction, useRemediationRefresh } from "./RemediationAction";
import type { RemediationControl } from "@/lib/remediation-ui";
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
  remediation?: RemediationControl;
};
export function MediaView({
  items,
  total = items.length,
  page = 1,
  pages = 1,
  status = "",
  search = "",
}: {
  items: Item[];
  total?: number;
  page?: number;
  pages?: number;
  status?: string;
  search?: string;
}) {
  useRemediationRefresh(items.map((item) => item.remediation));
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filter = status;
  function setFilter(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("status", value);
    else next.delete("status");
    next.delete("page");
    router.push(`${pathname}?${next}`, { scroll: false });
  }
  const [message, setMessage] = useState("");
  // The server supplies exactly one filtered page; actions never include hidden rows.
  const shown = items;
  function pageHref(value: number) {
    const next = new URLSearchParams(params.toString());
    next.set("page", String(value));
    return `${pathname}?${next}`;
  }
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
        <form action={pathname} method="get">
          <input type="hidden" name="status" value={filter} />
          <label>
            Search
            <input
              key={search}
              name="q"
              defaultValue={search}
              maxLength={256}
            />
          </label>
          <button type="submit">Search</button>
        </form>
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
      <p>
        {total} matching items · Page {page} of {pages}
      </p>
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
                    {(!item.remediation ||
                      item.remediation.state === "Ready") &&
                      item.action_state}
                    <br />
                    <button onClick={() => void rescan([item])}>Rescan</button>
                    <RemediationAction control={item.remediation} />
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
      {pages > 1 && (
        <div className="actions" role="group" aria-label="Media pages">
          {page > 1 && (
            <Link className="button" href={pageHref(page - 1)}>
              Previous page
            </Link>
          )}
          {page < pages && (
            <Link className="button" href={pageHref(page + 1)}>
              Next page
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
