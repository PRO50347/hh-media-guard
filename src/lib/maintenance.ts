import { raw, jobQueue, getSettings, needsAttention } from "./store";
export function maintenance(now = Date.now()) {
  const terminal = raw()
    .prepare("SELECT id,error,payload FROM jobs WHERE state='needs-attention'")
    .all() as { id: string; error: string; payload: string }[];
  for (const job of terminal) {
    if (!raw().prepare("SELECT 1 FROM attention WHERE subject=?").get(job.id))
      needsAttention(job.id, "worker recovery or job failure", {
        jobId: job.id,
        reason: job.error,
      });
  }
  const hours = getSettings().scanIntervalHours || 0;
  if (!hours) return;
  raw()
    .transaction(() => {
      const scheduled = raw()
        .prepare("SELECT next_at FROM schedule_state WHERE id=1")
        .get() as { next_at: number } | undefined;
      if (scheduled && scheduled.next_at > now) return;
      jobQueue.enqueue("scan-library", {});
      raw()
        .prepare(
          "INSERT INTO schedule_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at",
        )
        .run(now + hours * 3600000);
    })
    .immediate();
}
export function recoverOperations() {
  const operations = raw()
    .prepare(
      "SELECT id FROM operations WHERE state NOT IN ('pending','complete','needs-attention')",
    )
    .all() as { id: string }[];
  for (const operation of operations) {
    raw()
      .prepare(
        "UPDATE operations SET state='needs-attention',error='Interrupted operation; external outcome must be reconciled manually' WHERE id=?",
      )
      .run(operation.id);
    needsAttention(operation.id, "interrupted remediation", {
      operationId: operation.id,
    });
  }
  const movements = raw()
    .prepare(
      "SELECT id FROM quarantines WHERE state IN ('moving','restoring','cleaning')",
    )
    .all() as { id: string }[];
  for (const item of movements) {
    raw()
      .prepare("UPDATE quarantines SET state='needs-attention' WHERE id=?")
      .run(item.id);
    needsAttention(item.id, "interrupted quarantine movement", {
      operationId: item.id,
    });
  }
}
