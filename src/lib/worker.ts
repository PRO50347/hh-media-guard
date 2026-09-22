import {
  integration,
  integrationKey,
  roots,
  saveScan,
  jobQueue,
  raw,
  needsAttention,
  getSettings,
  upsertMediaItem,
} from "./store";
import { safeMediaPath } from "./security";
import { fingerprint, scanFile } from "./scanner";
import { decryptSecret } from "./crypto";
import { RadarrClient, SonarrClient } from "./clients";
import {
  enumerateRadarr,
  enumerateSonarr,
  translateArrPath,
  type AuditScope,
  type LibraryFile,
} from "./library";
import { WorkerRunner } from "./worker-runner";
import type { LeasedJob } from "./job-queue";
import type { ScanResult } from "./types";

async function inspect(
  input: string,
  signal: AbortSignal,
  force = false,
): Promise<ScanResult> {
  const file = await safeMediaPath(input, roots());
  const stamp = await fingerprint(file, getSettings());
  const prior = raw()
    .prepare("SELECT data FROM scans WHERE fingerprint=?")
    .get(stamp) as { data: string } | undefined;
  if (prior && !force) return JSON.parse(prior.data) as ScanResult;
  return scanFile(file, signal);
}
function owns(job: LeasedJob, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!jobQueue.heartbeat(job)) throw new Error("Worker lease was revoked");
}

export async function executeJob(job: LeasedJob, signal: AbortSignal) {
  if (job.kind === "scan-library") {
    await auditLibrary(job, JSON.parse(job.payload) as AuditScope, signal);
    return;
  }
  if (job.kind !== "scan-file") {
    jobQueue.finish(job, "needs-attention", "Unsupported operation");
    return;
  }
  const payload = JSON.parse(job.payload) as {
    path?: string;
    source?: "sonarr" | "radarr";
    force?: boolean;
    arrPath?: string;
  };
  const input =
    payload.arrPath && payload.source
      ? translateArrPath(payload.source, payload.arrPath)
      : payload.path;
  if (!input) {
    needsAttention(job.id, "unmapped path", payload);
    jobQueue.finish(
      job,
      "needs-attention",
      "Configure a matching media path mapping",
    );
    return;
  }
  jobQueue.progress(job, 10, input);
  try {
    const scan = await inspect(input, signal, payload.force);
    owns(job, signal);
    saveScan(scan);
    if (scan.decision === "needs-analysis")
      needsAttention(input, "unknown language", scan);
  } catch (error) {
    if (!signal.aborted)
      needsAttention(input, "scanner failure", {
        error: error instanceof Error ? error.message : "Inspection failed",
      });
    throw error;
  }
}

async function auditLibrary(
  job: LeasedJob,
  scope: AuditScope,
  signal: AbortSignal,
) {
  const sources: ("sonarr" | "radarr")[] = scope.source
    ? [scope.source]
    : ["sonarr", "radarr"];
  const items: LibraryFile[] = [];
  for (const source of sources) {
    owns(job, signal);
    jobQueue.progress(job, 0, `Enumerating ${source}`);
    const config = integration(source);
    const encrypted = integrationKey(source);
    if (!config.enabled) {
      if (scope.source) throw new Error(`${source} is disabled`);
      continue;
    }
    if (!config.url || !encrypted)
      throw new Error(`${source} is missing its URL or API key`);
    const key = decryptSecret(encrypted);
    items.push(
      ...(source === "sonarr"
        ? await enumerateSonarr(new SonarrClient(config.url, key), scope)
        : await enumerateRadarr(new RadarrClient(config.url, key), scope)),
    );
  }
  raw()
    .prepare("UPDATE jobs SET total=? WHERE id=? AND lease_token=?")
    .run(items.length, job.id, job.leaseToken);
  let completed = 0;
  let failures = 0;
  for (const item of items) {
    owns(job, signal);
    const file = translateArrPath(item.source, item.arrPath);
    const mediaId = `${item.source}:${item.entityId}:${file || item.arrPath}`;
    upsertMediaItem({
      source: item.source,
      arrId: item.entityId,
      title: item.title,
      path: file || item.arrPath,
      identity: String(item.fileId),
    });
    raw()
      .prepare("UPDATE media_items SET details=? WHERE id=?")
      .run(JSON.stringify(item), mediaId);
    if (!file) {
      needsAttention(mediaId, "unmapped path", item);
      failures++;
    } else {
      try {
        const prior = raw()
          .prepare("SELECT decision FROM media_items WHERE id=?")
          .get(mediaId) as { decision: string } | undefined;
        if (!scope.filter || prior?.decision === scope.filter) {
          const scan = await inspect(file, signal, scope.force);
          owns(job, signal);
          saveScan(scan);
          raw()
            .prepare(
              "UPDATE media_items SET fingerprint=?,decision=?,last_scanned_at=? WHERE id=?",
            )
            .run(scan.fingerprint, scan.decision, scan.scannedAt, mediaId);
          if (scan.decision === "needs-analysis")
            needsAttention(mediaId, "unknown language", { item, scan });
        }
      } catch (error) {
        signal.throwIfAborted();
        needsAttention(mediaId, "scanner failure", {
          item,
          error: error instanceof Error ? error.message : "Inspection failed",
        });
        failures++;
      }
    }
    completed++;
    jobQueue.progress(
      job,
      Math.round((completed / items.length) * 100),
      item.title,
    );
    raw()
      .prepare("UPDATE jobs SET processed=? WHERE id=? AND lease_token=?")
      .run(completed, job.id, job.leaseToken);
  }
  if (failures)
    jobQueue.finish(job, "needs-attention", `${failures} items need attention`);
}

const runner = new WorkerRunner(jobQueue, executeJob);
export function startWorker() {
  if (process.env.MG_BUILD !== "1") runner.start();
}
export function stopWorker() {
  return runner.stop();
}
