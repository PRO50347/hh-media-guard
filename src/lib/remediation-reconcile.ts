import { lstat } from "node:fs/promises";
import { translateArrPath } from "./library";
import { SonarrClient } from "./clients";
import {
  freshRemediationScan,
  type RemediationClient,
} from "./remediation-preflight";
import { raw, needsAttention } from "./store";
import { requireRuntimeOwnership } from "./runtime-lease";
import type { MediaIdentity } from "./remediation";

/** Uses Arr reads only. Never infer supersession from a cached media row alone.
 * Unknown blocklist/search outcomes are not resolved by a new file appearing. */
export async function reconcileRemediation(
  identity: MediaIdentity,
  client: RemediationClient,
) {
  const old = raw()
    .prepare(
      "SELECT id,file_id,state,evidence FROM operations WHERE source=? AND entity_id=? AND file_id<>? AND state NOT IN ('complete','superseded','no-fix-needed')",
    )
    .all(identity.source, identity.entityId, identity.fileId) as {
    id: string;
    file_id: number;
    state: string;
    evidence: string;
  }[];
  if (!old.length) return false;
  const scan = await freshRemediationScan(identity, client);
  const files =
    client instanceof SonarrClient
      ? await client.episodeFiles(identity.seriesId!)
      : await client.movieFiles(identity.entityId);
  for (const op of old) {
    const previous = JSON.parse(op.evidence).identity as MediaIdentity;
    if (
      previous.source !== identity.source ||
      previous.entityId !== identity.entityId ||
      previous.seriesId !== identity.seriesId
    )
      continue;
    if (
      raw()
        .prepare(
          "SELECT 1 FROM jobs WHERE kind='remediate' AND state IN ('queued','running','retrying') AND json_extract(payload,'$.identity.source')=? AND json_extract(payload,'$.identity.fileId')=?",
        )
        .get(identity.source, op.file_id)
    )
      continue;
    if (files.some((file) => file.id === op.file_id)) continue;
    const oldFile =
      client instanceof SonarrClient
        ? await client.findEpisodeFile(op.file_id)
        : await client.findMovieFile(op.file_id);
    if (oldFile) continue;
    const steps = raw()
      .prepare("SELECT step FROM operation_steps WHERE operation_id=?")
      .all(op.id) as { step: string }[];
    const names = new Set(steps.map((row) => row.step));
    const pairs = {
      "quarantine-intent": "quarantine",
      "backup-copy-intent": "backup-copy",
      "rescan-command-intent": "rescan-command",
      "history-failed-intent": "history-failed",
      "replacement-search-intent": "replacement-search",
    };
    const known = new Set([
      "pre-mutation-failure",
      "retry-authorized",
      "mutation-started",
      "arr-delete-intent",
      "arr-delete-verified",
      "blocklist-verified",
      ...Object.keys(pairs),
      ...Object.values(pairs),
    ]);
    if (
      steps.some((row) => !known.has(row.step)) ||
      Object.entries(pairs).some(
        ([intent, outcome]) => names.has(intent) && !names.has(outcome),
      )
    )
      continue;
    if (names.has("arr-delete-intent") && !names.has("arr-delete-verified")) {
      const oldPath = translateArrPath(previous.source, previous.arrPath);
      if (!oldPath) continue;
      if (oldPath === scan.path) {
        if (JSON.parse(op.evidence).scan?.fingerprint === scan.fingerprint)
          continue;
      } else {
        try {
          await lstat(oldPath);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
      }
    }
    requireRuntimeOwnership();
    raw()
      .transaction(() => {
        if (
          raw()
            .prepare(
              "SELECT 1 FROM jobs WHERE kind='remediate' AND state IN ('queued','running','retrying') AND json_extract(payload,'$.identity.source')=? AND json_extract(payload,'$.identity.fileId')=?",
            )
            .get(identity.source, op.file_id)
        )
          return;
        // No async gap between state comparison, evidence journal and transition.
        const state =
          op.state === "pending" && scan.decision === "pass"
            ? "complete"
            : "superseded";
        const updated = raw()
          .prepare(
            "UPDATE operations SET state=?,updated_at=? WHERE id=? AND state=?",
          )
          .run(state, new Date().toISOString(), op.id, op.state);
        if (!updated.changes) return;
        raw()
          .prepare(
            "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
          )
          .run(
            op.id,
            state === "complete" ? "verified-replacement" : "superseded",
            JSON.stringify({
              scan,
              identity,
              oldFileId: op.file_id,
              reason: "Media changed outside Media Guard",
            }),
            new Date().toISOString(),
          );
        if (state === "superseded" && scan.decision === "pass")
          raw()
            .prepare(
              "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
            )
            .run(
              op.id,
              "verified-replacement",
              JSON.stringify({ scan, identity }),
              new Date().toISOString(),
            );
        raw()
          .prepare(
            "UPDATE media_items SET action_state=? WHERE source=? AND arr_id=? AND identity=?",
          )
          .run(
            scan.decision === "needs-analysis" ? "needs-attention" : "none",
            identity.source,
            identity.entityId,
            String(identity.fileId),
          );
        if (scan.decision !== "pass")
          needsAttention(
            scan.path,
            scan.decision === "fail"
              ? "missing required language"
              : "unknown language",
            { scan, identity },
          );
      })
      .immediate();
  }
  // A new wrong-language replacement always needs another explicit action,
  // including in Automatic mode; never silently cascade replacement searches.
  return true;
}
