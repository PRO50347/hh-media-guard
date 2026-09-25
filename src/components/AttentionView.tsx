"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, json } from "./api";
import {
  attentionEvidence,
  attentionDetails,
  attentionFilters,
  attentionHref,
  reasonOptions,
} from "@/lib/attention-view";
import type { attentionQueue } from "@/lib/attention-query";
export function AttentionView({
  queue,
}: {
  queue: ReturnType<typeof attentionQueue>;
}) {
  const { items, summary, mediaCounts, total } = queue;
  const pagination = queue;
  const params = useSearchParams();
  const filters = attentionFilters(params);
  const [message, setMessage] = useState("");
  const router = useRouter();
  async function act(id: string, action: string) {
    if (
      action !== "rescan" &&
      !confirm(
        `Record a manual ${action} override? Original scan evidence remains unchanged.`,
      )
    )
      return;
    try {
      await api("/api/attention", json("POST", { id, action }));
      setMessage("Action recorded");
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <p>
        Uncertain results never authorize automatic media deletion.{" "}
        <Link href="/settings">Correct mappings or policy →</Link>
      </p>
      <p>
        Accept and Ignore pause automatic replacements for identified titles.
        Reset clears title limits and that pause; it never repeats uncertain
        external operations. Retry audits current Arr identity and respects
        remaining limits.
      </p>
      <p role="status">{message}</p>
      <section className="card" aria-label="Queue filters">
        <h2>Work queue</h2>
        <p>
          {summary.open} open · {summary.ignored} ignored · {summary.accepted}{" "}
          accepted
        </p>
        <div className="actions" role="group" aria-label="Media type">
          {(
            [
              ["all", "All"],
              ["movies", "Movies"],
              ["tv", "TV Shows"],
            ] as const
          ).map(([value, label]) => (
            <Link
              key={value}
              className="button queue-filter"
              aria-current={filters.media === value ? "true" : undefined}
              href={attentionHref(params, "media", value)}
              scroll={false}
            >
              {label} ({mediaCounts[value]})
            </Link>
          ))}
        </div>
        <div className="form-grid">
          <label>
            Reason
            <select
              value={filters.reason}
              onChange={(event) =>
                router.replace(
                  attentionHref(params, "reason", event.target.value),
                  { scroll: false },
                )
              }
            >
              {reasonOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Attention status
            <select
              value={filters.status}
              onChange={(event) =>
                router.replace(
                  attentionHref(params, "status", event.target.value),
                  { scroll: false },
                )
              }
            >
              <option value="open">Open</option>
              <option value="all">All statuses</option>
              <option value="accepted">Accepted</option>
              <option value="ignored">Ignored</option>
            </select>
          </label>
        </div>
        <Link href="/attention" scroll={false}>
          Reset filters
        </Link>
      </section>
      <p role="status">
        {total} matching items · Page {pagination.page} of {pagination.pages}
      </p>
      {items.length ? (
        items.map((item) => (
          <section className="card attention-item" key={item.id}>
            <h2>{attentionDetails(item).title}</h2>
            <div className="actions">
              <span className="badge">
                {attentionDetails(item).media === "movies"
                  ? "Movie"
                  : attentionDetails(item).media === "tv"
                    ? "TV Show"
                    : "Media type unavailable"}
              </span>
              <span className="badge">{attentionDetails(item).source}</span>
              <span className="badge">{item.state}</span>
            </div>
            <p>
              <strong>Reason:</strong> {item.reason}
            </p>
            {attentionDetails(item).title !== item.subject && (
              <p className="muted">{item.subject}</p>
            )}
            <details>
              <summary>View evidence</summary>
              <pre>{attentionEvidence(item.evidence)}</pre>
            </details>
            <div className="actions">
              <button onClick={() => void act(item.id, "rescan")}>
                Rescan
              </button>
              <button onClick={() => void act(item.id, "retry")}>
                Retry title audit
              </button>
              <button onClick={() => void act(item.id, "reset")}>
                Reset title limits
              </button>
              <button onClick={() => void act(item.id, "accept")}>
                Manually accept
              </button>
              <button onClick={() => void act(item.id, "ignore")}>
                Ignore
              </button>
            </div>
          </section>
        ))
      ) : (
        <p className="card empty">
          No items match these filters. Try another reason, media type, or
          status.
        </p>
      )}
      {pagination.pages > 1 && (
        <div className="actions" role="group" aria-label="Queue pages">
          {pagination.page > 1 && (
            <Link
              className="button"
              href={attentionHref(params, "page", String(pagination.page - 1))}
            >
              Previous page
            </Link>
          )}
          {pagination.page < pagination.pages && (
            <Link
              className="button"
              href={attentionHref(params, "page", String(pagination.page + 1))}
            >
              Next page
            </Link>
          )}
        </div>
      )}
    </>
  );
}
