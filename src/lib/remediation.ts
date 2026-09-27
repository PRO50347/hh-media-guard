import { reconcileRemediation } from "./remediation-reconcile";
import {
  freshRemediationScan,
  exactCurrentFile,
  verifyArrDeletion,
} from "./remediation-preflight";
import { correlateRelease, corroborateBlocklist } from "./remediation-history";
import { requireManualAdmission } from "./remediation-admission";
import type { LeasedJob } from "./job-queue";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { RadarrClient, SonarrClient } from "./clients";
import {
  raw,
  getSettings,
  needsAttention,
  audit,
  integration,
  integrationKey,
  roots,
} from "./store";
import { decryptSecret } from "./crypto";
import {
  preserveRecoveryCopy,
  verifyRecoveryCopy,
  quarantineRoot,
} from "./quarantine";
import { decideAudio } from "./rules";
import { translateArrPath } from "./library";
import { reserveReplacement } from "./retries";
import type { ScanResult } from "./types";
import { safeMediaPath } from "./security";
import { fingerprint } from "./scanner";
import {
  preMutationRetryProof,
  sameIdentity,
  type RetryOperation,
} from "./remediation-retry";
import { remediationReason } from "./remediation-errors";
import { requireRuntimeOwnership } from "./runtime-lease";

export interface MediaIdentity {
  source: "sonarr" | "radarr";
  entityId: number;
  seriesId?: number;
  fileId: number;
  arrPath: string;
  downloadId?: string;
}
type Client = SonarrClient | RadarrClient;
export function requireRemediationAllowed() {
  requireRuntimeOwnership();
  if (
    process.env.ALLOW_DESTRUCTIVE_ACTIONS !== "true" ||
    !["manual", "automatic"].includes(getSettings().safetyMode)
  )
    throw new Error("Remediation is disabled");
}
export function clientFor(source: "sonarr" | "radarr"): Client {
  const config = integration(source);
  const key = integrationKey(source);
  if (!config.enabled || !config.url || !key)
    throw new Error("Integration is not configured");
  return source === "sonarr"
    ? new SonarrClient(config.url, decryptSecret(key))
    : new RadarrClient(config.url, decryptSecret(key));
}
function state(id: string, value: string) {
  raw()
    .prepare("UPDATE operations SET state=?,updated_at=? WHERE id=?")
    .run(value, new Date().toISOString(), id);
}
function step(id: string, name: string, result: unknown) {
  // Record only expected response identifiers, never arbitrary server bodies.
  raw()
    .prepare(
      "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
    )
    .run(id, name, JSON.stringify(result), new Date().toISOString());
  audit("remediation", `${id}: ${name}`);
}
/** Each non-idempotent external step is journaled BEFORE dispatch. An uncertain
 * response is never retried automatically: the operation requires inspection. */
export async function remediate(
  scan: ScanResult,
  identity: MediaIdentity,
  provided?: Client,
  signal = new AbortController().signal,
  requireJobOwnership: () => void = () => {},
  retry?: { operationId: string; token: string },
  manualJob?: LeasedJob,
) {
  const authorize = () => {
    requireJobOwnership();
    signal.throwIfAborted();
    requireRemediationAllowed();
    if (getSettings().safetyMode === "manual") {
      const job =
        manualJob &&
        (raw()
          .prepare(
            "SELECT payload FROM jobs WHERE id=? AND kind='remediate' AND state='running' AND lease_token=?",
          )
          .get(manualJob.id, manualJob.leaseToken) as
          | { payload: string }
          | undefined);
      const payload = job && JSON.parse(job.payload);
      if (
        !payload ||
        !sameIdentity(payload.identity, identity) ||
        !payload.mediaId
      )
        throw new Error(
          "Manual remediation requires an explicitly authorized job",
        );
    }
  };
  authorize();
  if (getSettings().safetyMode === "manual")
    raw()
      .transaction(() =>
        requireManualAdmission(manualJob!.id, retry?.operationId),
      )
      .immediate();
  if (scan.decision !== "fail" || !scan.fingerprint)
    throw new Error("Conclusive failed evidence required");
  const client = provided || clientFor(identity.source);
  scan = await freshRemediationScan(identity, client, signal);
  authorize();
  if (scan.decision !== "fail") {
    if (retry) {
      const prior = raw()
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(retry.operationId) as RetryOperation;
      if (!prior || !preMutationRetryProof(prior, "retry-queued"))
        throw new Error(
          "Pre-mutation retry proof is no longer valid; manual inspection required",
        );
      state(
        prior.id,
        scan.decision === "pass" ? "no-fix-needed" : "needs-attention",
      );
    }
    if (scan.decision === "needs-analysis")
      needsAttention(scan.path, "unknown language", scan);
    return scan.decision === "pass" ? "no-fix-needed" : "fresh-needs-analysis";
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        identity.source,
        identity.entityId,
        identity.fileId,
        scan.fingerprint,
      ]),
    )
    .digest("hex");
  let id: string = randomUUID();
  const now = new Date().toISOString();
  const created = retry
    ? 0
    : raw()
        .prepare(
          "INSERT OR IGNORE INTO operations(id,operation_key,source,entity_id,file_id,state,evidence,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?)",
        )
        .run(
          id,
          key,
          identity.source,
          identity.entityId,
          identity.fileId,
          JSON.stringify({ scan, identity }),
          now,
          now,
        ).changes;
  if (!created) {
    const existing = (
      retry
        ? raw()
            .prepare("SELECT * FROM operations WHERE id=?")
            .get(retry.operationId)
        : raw()
            .prepare("SELECT * FROM operations WHERE operation_key=?")
            .get(key)
    ) as RetryOperation;
    if (!existing)
      throw new Error("Retry does not match the original operation");
    if (!retry)
      return existing.state === "needs-attention"
        ? "needs-attention"
        : "duplicate";
    const claimed = raw()
      .transaction(() => {
        authorize();
        const authorization = raw()
          .prepare(
            "SELECT result FROM operation_steps WHERE operation_id=? AND step='retry-authorized' ORDER BY id DESC LIMIT 1",
          )
          .get(existing.id) as { result: string } | undefined;
        if (
          existing.id !== retry.operationId ||
          !preMutationRetryProof(existing, "retry-queued") ||
          !authorization ||
          JSON.parse(authorization.result).token !== retry.token ||
          !sameIdentity(JSON.parse(existing.evidence).identity, identity)
        )
          throw new Error(
            "Pre-mutation retry proof is no longer valid; manual inspection required",
          );
        return raw()
          .prepare(
            "UPDATE operations SET state='planned',updated_at=? WHERE id=? AND state='retry-queued'",
          )
          .run(now, existing.id).changes;
      })
      .immediate();
    if (!claimed) throw new Error("Retry already claimed");
    id = existing.id;
  }
  let mutationStarted = false;
  try {
    const episodeIds = await validateRemediationIdentity(
      scan,
      identity,
      client,
    );
    // History failure can itself enqueue a search in Arr. Require that behavior
    // disabled so Media Guard owns one durable search budget and command.
    if ((await client.downloadHandling()).autoRedownloadFailed)
      throw new Error(
        "Disable Arr automatic failed-download redownload before using remediation",
      );
    const release = await correlateRelease(client, identity);
    const blocklistScope =
      identity.source === "sonarr"
        ? { seriesId: identity.seriesId! }
        : { movieId: identity.entityId };
    await quarantineRoot();
    const blocklistBefore = await client.blocklist(blocklistScope);
    const releaseKey = createHash("sha256")
      .update(
        JSON.stringify([
          identity.source,
          release.sourceTitle!.trim().toLowerCase(),
        ]),
      )
      .digest("hex");
    authorize();
    const downloadKey = createHash("sha256")
      .update(`${identity.source}:download:${release.downloadId}`)
      .digest("hex");
    // Durable intent precedes even reservation, so a crash can never make a
    // partially dispatched operation appear safe to replay.
    mutationStarted = true;
    step(id, "mutation-started", { scan, identity });
    reserveReplacement(
      `${identity.source}:${identity.entityId}`,
      releaseKey,
      Date.now(),
      [downloadKey],
    );
    raw()
      .prepare("UPDATE operations SET release_key=? WHERE id=?")
      .run(releaseKey, id);
    state(id, "backing-up");
    step(id, "backup-copy-intent", {});
    const quarantineId = await preserveRecoveryCopy(scan, signal, authorize);
    raw()
      .prepare("UPDATE operations SET quarantine_id=? WHERE id=?")
      .run(quarantineId, id);
    step(id, "backup-copy", { quarantineId });
    authorize();
    await validateRemediationIdentity(scan, identity, client);
    if (
      (await safeMediaPath(scan.path, roots())) !== scan.path ||
      (await fingerprint(scan.path, getSettings())) !== scan.fingerprint
    )
      throw new Error("Media or policy changed since scanning");
    authorize();
    await verifyRecoveryCopy(quarantineId);
    authorize();
    state(id, "deleting");
    step(id, "arr-delete-intent", { fileId: identity.fileId });
    try {
      if (client instanceof SonarrClient)
        await client.deleteEpisodeFile(identity.fileId);
      else await client.deleteMovieFile(identity.fileId);
    } catch {
      throw new Error(
        "Arr deletion outcome is uncertain; inspect the retained backup and Arr before proceeding",
      );
    }
    await verifyArrDeletion(identity, client, scan.path);
    step(id, "arr-delete-verified", { fileId: identity.fileId });
    authorize();
    if ((await client.downloadHandling()).autoRedownloadFailed)
      throw new Error("Arr redownload settings changed");
    authorize();
    state(id, "blocklisting");
    step(id, "history-failed-intent", { historyId: release.id });
    await client.markHistoryFailed(release.id);
    step(id, "history-failed", { historyId: release.id });
    authorize();
    const blocklistId = corroborateBlocklist(
      blocklistBefore,
      await client.blocklist(blocklistScope),
      release,
      identity,
    );
    step(id, "blocklist-verified", { blocklistId });
    authorize();
    state(id, "searching");
    step(id, "replacement-search-intent", {});
    const search = z
      .object({ id: z.number().int().positive() })
      .parse(
        client instanceof SonarrClient
          ? await client.searchEpisode(episodeIds)
          : await client.searchMovie([identity.entityId]),
      );
    step(id, "replacement-search", { id: search.id });
    state(id, "pending");
    raw()
      .prepare(
        "UPDATE media_items SET action_state='pending' WHERE source=? AND arr_id=?",
      )
      .run(identity.source, identity.entityId);
    return "pending";
  } catch (error) {
    state(id, "needs-attention");
    if (!mutationStarted) step(id, "pre-mutation-failure", {});
    const safeError = remediationReason(error, identity.source);
    raw()
      .prepare("UPDATE operations SET error=? WHERE id=?")
      .run(safeError, id);
    needsAttention(id, "replacement failure", {
      operationId: id,
      reason: safeError,
    });
    raw()
      .prepare(
        "UPDATE media_items SET action_state='needs-attention' WHERE source=? AND arr_id=?",
      )
      .run(identity.source, identity.entityId);
    return "needs-attention";
  }
}
export async function verifyReplacement(
  scan: ScanResult,
  identity: MediaIdentity,
  provided?: Client,
) {
  // Persist the explicit-action boundary across subsequent scheduled scans too.
  // A replacement that fails must never start an automatic replacement loop.
  if (
    raw()
      .prepare(
        `SELECT 1 FROM operation_steps s JOIN operations o ON o.id=s.operation_id
    WHERE o.source=? AND o.entity_id=? AND s.step IN ('superseded','verified-replacement')
    AND json_extract(s.result,'$.identity.fileId')=? LIMIT 1`,
      )
      .get(identity.source, identity.entityId, identity.fileId)
  )
    return true;
  if (
    !scan.fingerprint ||
    !raw()
      .prepare(
        "SELECT 1 FROM operations WHERE source=? AND entity_id=? AND file_id<>? AND state NOT IN ('complete','superseded','no-fix-needed') LIMIT 1",
      )
      .get(identity.source, identity.entityId, identity.fileId)
  )
    return false;
  return reconcileRemediation(identity, provided || clientFor(identity.source));
}

/** Recheck a persisted PASS and the current Arr file before allowing cleanup. */
export async function validateReplacementEvidence(
  scan: ScanResult,
  identity: MediaIdentity,
  provided?: Client,
) {
  requireRuntimeOwnership();
  if (scan.decision !== "pass" || !scan.fingerprint)
    throw new Error("Verified replacement evidence required");
  if ((await safeMediaPath(scan.path, roots())) !== scan.path)
    throw new Error("Replacement path is no longer safe");
  const stored = raw()
    .prepare("SELECT data FROM scans WHERE fingerprint=? AND decision='pass'")
    .get(scan.fingerprint) as { data: string } | undefined;
  if (
    !stored ||
    JSON.parse(stored.data).path !== scan.path ||
    (await fingerprint(scan.path, getSettings())) !== scan.fingerprint
  )
    throw new Error("Replacement evidence is missing or changed");
  const persisted = JSON.parse(stored.data) as ScanResult;
  if (
    persisted.decision !== "pass" ||
    persisted.fingerprint !== scan.fingerprint ||
    decideAudio(
      persisted.duration,
      persisted.tracks,
      getSettings(),
      persisted.arrFileEvidence,
    ).decision !== "pass"
  )
    throw new Error("Replacement evidence is no longer a conclusive pass");
  const client = provided || clientFor(identity.source);
  const file =
    client instanceof SonarrClient
      ? await client.episodeFile(identity.fileId)
      : await client.movieFile(identity.fileId);
  if (
    file.id !== identity.fileId ||
    file.path !== identity.arrPath ||
    translateArrPath(identity.source, file.path) !== scan.path ||
    (identity.source === "sonarr"
      ? file.seriesId !== identity.seriesId
      : file.movieId !== identity.entityId)
  )
    throw new Error("Replacement identity is inconsistent");
  if (
    client instanceof SonarrClient &&
    !(await client.episodes(identity.seriesId!)).some(
      (episode) =>
        episode.id === identity.entityId &&
        episode.episodeFileId === identity.fileId,
    )
  )
    throw new Error("Replacement episode identity is inconsistent");
  const currentLanguages = {
    source: identity.source,
    entityId: identity.entityId,
    fileId: file.id,
    arrPath: file.path,
    languages: (file.languages || []).map((language) => language.name),
  };
  if (
    decideAudio(
      persisted.duration,
      persisted.tracks,
      getSettings(),
      currentLanguages,
    ).decision !== "pass"
  )
    throw new Error(
      "Current replacement language evidence is not a conclusive pass",
    );
  requireRuntimeOwnership();
  if ((await fingerprint(scan.path, getSettings())) !== scan.fingerprint)
    throw new Error("Replacement changed during verification");
}

/** Read-only, current exact-file validation shared by initial attempts and
 * explicit pre-mutation retries. No history rejection or search occurs here. */
export async function validateRemediationIdentity(
  scan: ScanResult,
  identity: MediaIdentity,
  provided?: Client,
) {
  requireRemediationAllowed();
  const client = provided || clientFor(identity.source);
  const current = await exactCurrentFile(identity, client);
  if (translateArrPath(identity.source, current.path) !== scan.path)
    throw new Error("Arr file identity does not match mapped evidence");
  const currentLanguages = {
    source: identity.source,
    entityId: identity.entityId,
    fileId: current.id,
    arrPath: current.path,
    languages: (current.languages || []).map((language) => language.name),
  };
  if (
    decideAudio(scan.duration, scan.tracks, getSettings(), currentLanguages)
      .decision !== "fail"
  )
    throw new Error(
      "Current exact-file language evidence is not a conclusive failure",
    );
  const episodeIds =
    client instanceof SonarrClient
      ? (await client.episodes(identity.seriesId!))
          .filter((e) => e.episodeFileId === identity.fileId)
          .map((e) => e.id)
      : [];
  if (
    identity.source === "sonarr" &&
    (episodeIds.length !== 1 || episodeIds[0] !== identity.entityId)
  )
    throw new Error(
      "Single-episode identity is required; multi-episode files need manual attention",
    );
  return episodeIds;
}
