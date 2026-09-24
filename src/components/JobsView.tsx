"use client";
import { useEffect, useState } from "react";
import { jobStatusLabel } from "@/lib/job-status";
import { Job } from "@/lib/types";
import { api, json } from "./api";
export function JobsView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState("Loading jobs…");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<Job[]>("/api/jobs")
        .then((items) => {
          if (active) {
            setJobs(items);
            setMessage("");
          }
        })
        .catch((e) => {
          if (active) setMessage(e.message);
        });
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="card">
      <p role="status">{message}</p>
      {!jobs.length && !message && (
        <p className="empty">No jobs yet. Start a scan from Library.</p>
      )}
      {jobs.map((job) => (
        <article key={job.id}>
          <h2>
            {job.kind}{" "}
            <span className={"badge " + job.state}>{jobStatusLabel(job)}</span>
          </h2>
          <p className="muted">
            {job.id} · Attempt {job.attempts} · {job.updatedAt}
          </p>
          <progress
            max={100}
            value={job.progress}
            aria-label={`Progress for ${job.id}`}
          />
          <p>
            {job.progress}% · {job.processed || 0} / {job.total || 0} items ·{" "}
            {job.currentItem}
          </p>
          {job.error && <p className="error">{job.error}</p>}
          {job.state === "failed" && !job.processed && (
            <p>
              No media inspection completed. This is a scan/setup failure, not a
              media-language result.
            </p>
          )}
          {["queued", "running", "retrying"].includes(job.state) && (
            <button
              onClick={async () => {
                try {
                  await api("/api/jobs", json("DELETE", { id: job.id }));
                  setJobs(await api<Job[]>("/api/jobs"));
                } catch (e) {
                  setMessage((e as Error).message);
                }
              }}
            >
              Cancel job
            </button>
          )}
          <hr />
        </article>
      ))}
    </section>
  );
}
