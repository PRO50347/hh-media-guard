import type { Job } from "./types";
export function jobStatusLabel(job: Pick<Job, "kind" | "state" | "processed">) {
  if (job.state === "failed") return "Scan failed";
  // Historical exhausted jobs used needs-attention before this distinction.
  if (
    job.kind.startsWith("scan-") &&
    job.state === "needs-attention" &&
    !job.processed
  )
    return "Scan failed / setup needs attention";
  if (job.state === "needs-attention")
    return "Media / operation needs attention";
  return job.state;
}
