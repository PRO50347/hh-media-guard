import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { RadarrClient, SonarrClient, type ArrHistory } from "./clients";
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
import { moveToQuarantine } from "./quarantine";
import { decideAudio } from "./rules";
import { translateArrPath } from "./library";
import { reserveReplacement } from "./retries";
import type { ScanResult } from "./types";
import { safeMediaPath } from "./security";
import { fingerprint } from "./scanner";
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
    getSettings().safetyMode !== "automatic"
  )
    throw new Error("Automatic remediation is disabled");
}
function clientFor(source: "sonarr" | "radarr"): Client {
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
function correlate(
  history: ArrHistory[],
  identity: MediaIdentity,
  episodeIds: number[],
) {
  const related = (h: ArrHistory) =>
    identity.source === "radarr"
      ? h.movieId === identity.entityId
      : Boolean(h.episodeId && episodeIds.includes(h.episodeId));
  const imports = history.filter(
    (h) =>
      related(h) &&
      h.eventType === "downloadFolderImported" &&
      h.data?.droppedPath === identity.arrPath &&
      (!identity.downloadId || h.downloadId === identity.downloadId),
  );
  const downloads = [
    ...new Set(imports.map((h) => h.downloadId).filter(Boolean)),
  ];
  if (downloads.length !== 1)
    throw new Error("Ambiguous imported release history");
  const grabs = history.filter(
    (h) => h.eventType === "grabbed" && h.downloadId === downloads[0],
  );
  if (
    !grabs.length ||
    grabs.some((h) => !related(h)) ||
    grabs.some((h) => !h.sourceTitle) ||
    new Set(grabs.map((h) => h.sourceTitle)).size !== 1
  )
    throw new Error("Ambiguous release identity or multi-title download");
  return grabs[0];
}

/** Each non-idempotent external step is journaled BEFORE dispatch. An uncertain
 * response is never retried automatically: the operation requires inspection. */
export async function remediate(
  scan: ScanResult,
  identity: MediaIdentity,
  provided?: Client,
  signal = new AbortController().signal,
  requireJobOwnership: () => void = () => {},
) {
  const authorize = () => {
    requireJobOwnership();
    signal.throwIfAborted();
    requireRemediationAllowed();
  };
  authorize();
  if (scan.decision !== "fail" || !scan.fingerprint)
    throw new Error("Conclusive failed evidence required");
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
  const id = randomUUID();
  const now = new Date().toISOString();
  const created = raw()
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
    const existing = raw()
      .prepare("SELECT state FROM operations WHERE operation_key=?")
      .get(key) as { state: string };
    return existing.state === "needs-attention"
      ? "needs-attention"
      : "duplicate";
  }
  try {
    const client = provided || clientFor(identity.source);
    const current =
      client instanceof SonarrClient
        ? await client.episodeFile(identity.fileId)
        : await client.movieFile(identity.fileId);
    if (
      current.id !== identity.fileId ||
      current.path !== identity.arrPath ||
      translateArrPath(identity.source, current.path) !== scan.path ||
      (identity.source === "sonarr"
        ? current.seriesId !== identity.seriesId
        : current.movieId !== identity.entityId)
    )
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
    // History failure can itself enqueue a search in Arr. Require that behavior
    // disabled so Media Guard owns one durable search budget and command.
    if ((await client.downloadHandling()).autoRedownloadFailed)
      throw new Error(
        "Disable Arr automatic failed-download redownload before using Automatic mode",
      );
    const release = correlate(await client.history(), identity, episodeIds);
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
    reserveReplacement(
      `${identity.source}:${identity.entityId}`,
      releaseKey,
      Date.now(),
      [downloadKey],
    );
    raw()
      .prepare("UPDATE operations SET release_key=? WHERE id=?")
      .run(releaseKey, id);
    state(id, "quarantining");
    const quarantineId = await moveToQuarantine(scan, signal, authorize);
    raw()
      .prepare("UPDATE operations SET quarantine_id=? WHERE id=?")
      .run(quarantineId, id);
    step(id, "quarantine", { quarantineId });
    authorize();
    state(id, "rescanning");
    // Ask Arr to reconcile missing media, rather than DELETE a pathname that an
    // independent importer might concurrently replace.
    const command = z
      .object({ id: z.number().int().positive() })
      .parse(
        await client.command(
          identity.source === "sonarr" ? "RescanSeries" : "RescanMovie",
          identity.source === "sonarr"
            ? { seriesId: identity.seriesId }
            : { movieId: identity.entityId },
        ),
      );
    step(id, "rescan-command", { id: command.id });
    let complete = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      signal.throwIfAborted();
      const result = await client.commandStatus(command.id);
      if (result.id !== command.id)
        throw new Error("Arr command identity is inconsistent");
      if (result.status === "completed") {
        complete = true;
        break;
      }
      if (["failed", "aborted", "cancelled"].includes(result.status))
        throw new Error("Arr rescan failed");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!complete) throw new Error("Arr rescan timed out");
    const remaining =
      client instanceof SonarrClient
        ? await client.episodeFiles(identity.seriesId!)
        : await client.movieFiles(identity.entityId);
    if (
      remaining.some(
        (file) => file.id === identity.fileId || file.path === identity.arrPath,
      )
    )
      throw new Error("Arr still reports media at the original path");
    authorize();
    if ((await client.downloadHandling()).autoRedownloadFailed)
      throw new Error("Arr redownload settings changed");
    authorize();
    state(id, "blocklisting");
    await client.markHistoryFailed(release.id);
    step(id, "history-failed", { historyId: release.id });
    authorize();
    state(id, "searching");
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
    const safeError =
      error instanceof Error && error.message.startsWith("Arr ")
        ? "Arr operation failed or returned inconsistent evidence"
        : error instanceof Error
          ? error.message
          : "Remediation failed";
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
  if (scan.decision !== "pass") return;
  if (
    !raw()
      .prepare(
        "SELECT 1 FROM operations WHERE source=? AND entity_id=? AND state='pending'",
      )
      .get(identity.source, identity.entityId)
  )
    return;
  await validateReplacementEvidence(scan, identity, provided);
  requireRuntimeOwnership();
  const pending = raw()
    .prepare(
      "SELECT id FROM operations WHERE source=? AND entity_id=? AND file_id<>? AND state='pending'",
    )
    .all(identity.source, identity.entityId, identity.fileId) as {
    id: string;
  }[];
  raw()
    .transaction(() => {
      for (const operation of pending) {
        step(operation.id, "verified-replacement", { scan, identity });
        state(operation.id, "complete");
      }
      if (pending.length) {
        raw()
          .prepare(
            "UPDATE media_items SET action_state='none' WHERE source=? AND arr_id=?",
          )
          .run(identity.source, identity.entityId);
        audit(
          "replacement",
          `Verified replacement for ${identity.source}:${identity.entityId}`,
        );
      }
    })
    .immediate();
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
