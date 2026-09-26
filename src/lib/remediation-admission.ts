import { getSettings, raw } from "./store";
import {
  preMutationRetryProof,
  type RetryOperation,
} from "./remediation-retry";

/** Call within the same IMMEDIATE transaction that enqueues manual work.
 * Jobs cover the interval before an operation exists; operations cover pending
 * replacement and uncertain mutations even after the job has finished. */
export function requireManualAdmission(exceptJob = "", exceptOperation = "") {
  if (getSettings().safetyMode !== "manual") return;
  const job = raw()
    .prepare(
      "SELECT 1 FROM jobs WHERE kind='remediate' AND state IN ('queued','running','retrying') AND id<>? LIMIT 1",
    )
    .get(exceptJob);
  const operations = raw()
    .prepare("SELECT * FROM operations WHERE state<>'complete' AND id<>?")
    .all(exceptOperation) as RetryOperation[];
  if (job || operations.some((op) => !preMutationRetryProof(op)))
    throw new Error(
      "Another remediation is active or requires inspection; only one item is allowed at a time",
    );
}
