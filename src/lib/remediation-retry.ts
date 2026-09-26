import { raw } from "./store";
import type { MediaIdentity } from "./remediation";

export type RetryOperation = {
  id: string;
  state: string;
  source: string;
  entity_id: number;
  file_id: number;
  evidence: string;
  error: string | null;
  release_key: string | null;
  quarantine_id: string | null;
};

/** The v0.2.6 history parser failed before reservation/mutation. Recognize only
 * that structured Zod signature, never a substring supplied by a remote API. */
export function legacyHistoryParseFailure(message?: string | null) {
  if (!message || message.length > 65536) return false;
  try {
    const issues: unknown = JSON.parse(message);
    return (
      Array.isArray(issues) &&
      issues.length > 0 &&
      issues.every(
        (issue) =>
          issue?.code === "invalid_type" &&
          issue.expected === "string" &&
          issue.received === "null" &&
          Array.isArray(issue.path) &&
          issue.path.length === 4 &&
          issue.path[0] === "records" &&
          Number.isInteger(issue.path[1]) &&
          issue.path[2] === "data" &&
          typeof issue.path[3] === "string" &&
          issue.path[3] !== "droppedPath",
      )
    );
  } catch {
    return false;
  }
}

export function sameIdentity(a: MediaIdentity, b: MediaIdentity) {
  return (
    [
      "source",
      "entityId",
      "seriesId",
      "fileId",
      "arrPath",
      "downloadId",
    ] as const
  ).every((key) => a[key] === b[key]);
}

/** Read-only proof: no reservation, quarantine (including incomplete movement),
 * mutation intent, unknown step, or competing operation may exist. */
export function preMutationRetryProof(
  operation: RetryOperation,
  expectedState = "needs-attention",
) {
  if (
    operation.state !== expectedState ||
    operation.quarantine_id ||
    operation.release_key
  )
    return false;
  const steps = raw()
    .prepare("SELECT step FROM operation_steps WHERE operation_id=?")
    .all(operation.id) as { step: string }[];
  if (
    steps.some(
      ({ step }) =>
        !["pre-mutation-failure", "retry-authorized"].includes(step),
    )
  )
    return false;
  if (
    !steps.some(({ step }) => step === "pre-mutation-failure") &&
    !legacyHistoryParseFailure(operation.error)
  )
    return false;
  try {
    const { scan, identity } = JSON.parse(operation.evidence);
    if (
      !scan?.fingerprint ||
      !scan.path ||
      scan.decision !== "fail" ||
      !identity ||
      identity.source !== operation.source ||
      identity.entityId !== operation.entity_id ||
      identity.fileId !== operation.file_id
    )
      return false;
    const title = `${operation.source}:${operation.entity_id}`;
    if (
      raw().prepare("SELECT 1 FROM retry_titles WHERE identity=?").get(title) ||
      raw()
        .prepare("SELECT 1 FROM retry_releases WHERE title_identity=?")
        .get(title) ||
      raw()
        .prepare(
          "SELECT 1 FROM quarantines WHERE original_path=? OR json_extract(evidence,'$.scan.fingerprint')=?",
        )
        .get(scan.path, scan.fingerprint) ||
      raw()
        .prepare(
          "SELECT 1 FROM operations WHERE source=? AND entity_id=? AND id<>?",
        )
        .get(operation.source, operation.entity_id, operation.id)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
