import { requireManualAdmission } from "./remediation-admission";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./scanner";
import { safeMediaPath } from "./security";
import {
  preMutationRetryProof,
  sameIdentity,
  type RetryOperation,
} from "./remediation-retry";
import { remediationReason } from "./remediation-errors";
import { z } from "zod";
import {
  raw,
  getSettings,
  jobQueue,
  audit,
  roots,
  listMappings,
} from "./store";
import { translateArrPath } from "./library";
import { decideAudio } from "./rules";
import {
  requireRemediationAllowed,
  validateRemediationIdentity,
} from "./remediation";
import type { ScanResult } from "./types";
import { remediationState, type RemediationControl } from "./remediation-ui";

const identitySchema = z
  .object({
    source: z.enum(["sonarr", "radarr"]),
    entityId: z.number().int().positive(),
    fileId: z.number().int().positive(),
    seriesId: z.number().int().positive().optional(),
    arrPath: z.string().min(1),
    downloadId: z.string().optional(),
  })
  .refine((value) => value.source !== "sonarr" || !!value.seriesId);

export function remediationDisabledReason() {
  if (process.env.ALLOW_DESTRUCTIVE_ACTIONS !== "true")
    return "Remediation is disabled: ALLOW_DESTRUCTIVE_ACTIONS must be enabled by the server administrator.";
  if (!["manual", "automatic"].includes(getSettings().safetyMode))
    return "Remediation is disabled: select Manual Fix & Redownload or Automatic mode in Settings.";
}

type MediaRow = {
  id: string;
  source: string;
  arr_id: number;
  identity: string;
  path: string;
  fingerprint: string;
  decision: string;
  details: string;
  scan_data: string | null;
};
const mediaSelect = `SELECT m.*, s.data AS scan_data FROM media_items m
  LEFT JOIN scans s ON s.fingerprint=m.fingerprint AND s.decision='fail'`;
function mediaRow(mediaId: string) {
  return raw().prepare(`${mediaSelect} WHERE m.id=?`).get(mediaId) as
    | MediaRow
    | undefined;
}

/** The browser supplies only a media ID. Neither scan evidence nor Arr identity
 * from a request can authorize remediation. Re-read this again in the worker. */
export function loadManualRemediation(mediaId: string) {
  return validatePersistedMedia(
    mediaRow(mediaId),
    getSettings(),
    listMappings(),
  );
}
function validatePersistedMedia(
  media: MediaRow | undefined,
  settings: ReturnType<typeof getSettings>,
  mappings: ReturnType<typeof listMappings>,
) {
  if (!media || media.decision !== "fail" || !media.fingerprint)
    throw new Error(
      "A persisted conclusive failed scan is required. Rescan this file first.",
    );
  const identity = identitySchema.parse(JSON.parse(media.details));
  if (
    identity.source !== media.source ||
    identity.entityId !== media.arr_id ||
    String(identity.fileId) !== media.identity ||
    translateArrPath(identity.source, identity.arrPath, mappings) !== media.path
  )
    throw new Error("Exact Arr file identity does not match persisted media.");
  if (!media.scan_data)
    throw new Error("Persisted failed evidence is unavailable.");
  const scan = JSON.parse(media.scan_data) as ScanResult;
  const arr = scan.arrFileEvidence;
  if (
    scan.path !== media.path ||
    scan.fingerprint !== media.fingerprint ||
    scan.decision !== "fail" ||
    (arr &&
      (arr.source !== identity.source ||
        arr.entityId !== identity.entityId ||
        arr.fileId !== identity.fileId ||
        arr.arrPath !== identity.arrPath))
  )
    throw new Error("Failed evidence does not match exact Arr file identity.");
  if (
    decideAudio(scan.duration, scan.tracks, settings, arr).decision !== "fail"
  )
    throw new Error(
      "Stored evidence is no longer a conclusive failure. Rescan first.",
    );
  return { media, scan, identity };
}

function operationFor(media: NonNullable<ReturnType<typeof mediaRow>>) {
  return raw()
    .prepare(
      `SELECT * FROM operations WHERE source=? AND entity_id=?
    AND ((file_id=? AND json_extract(evidence,'$.scan.fingerprint')=?) OR state='pending'
      OR (state='complete' AND ?='pass')) ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(
      media.source,
      media.arr_id,
      Number(media.identity),
      media.fingerprint,
      media.decision,
    ) as RetryOperation | undefined;
}

export function manualRemediationControl(mediaId: string): RemediationControl {
  return withRemediation([{ id: mediaId }])[0].remediation;
}

/** Bounded batches: callers pass only the current page. No per-row operation,
 * job, scan, settings, or mapping lookup is needed for ordinary eligibility. */
export function withRemediation<T extends { id: string }>(items: T[]) {
  if (!items.length) return [] as (T & { remediation: RemediationControl })[];
  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => "?").join(",");
  const media = new Map(
    (
      raw()
        .prepare(`${mediaSelect} WHERE m.id IN (${placeholders})`)
        .all(...ids) as MediaRow[]
    ).map((row) => [row.id, row]),
  );
  const operations = raw()
    .prepare(
      `SELECT o.*,m.id AS media_id FROM operations o JOIN media_items m
    ON o.source=m.source AND o.entity_id=m.arr_id WHERE m.id IN (${placeholders})
    AND ((o.file_id=CAST(m.identity AS INTEGER) AND json_extract(o.evidence,'$.scan.fingerprint')=m.fingerprint)
      OR o.state='pending' OR (o.state='complete' AND m.decision='pass'))
    ORDER BY o.created_at DESC,o.id DESC`,
    )
    .all(...ids) as (RetryOperation & { media_id: string })[];
  const jobs = raw()
    .prepare(
      `SELECT j.state,m.id AS media_id FROM jobs j JOIN media_items m
    ON json_extract(j.payload,'$.mediaId')=m.id AND json_extract(j.payload,'$.fingerprint')=m.fingerprint
    WHERE j.kind='remediate' AND m.id IN (${placeholders}) ORDER BY j.created_at DESC,j.id DESC`,
    )
    .all(...ids) as { media_id: string; state: string }[];
  const settings = getSettings();
  const mappings = listMappings();
  const disabled = remediationDisabledReason();
  return items.map((item) => {
    const operation = operations.find((op) => op.media_id === item.id);
    const job = jobs.find((row) => row.media_id === item.id);
    let eligible = false;
    let retryOperationId: string | undefined;
    try {
      const validated = validatePersistedMedia(
        media.get(item.id),
        settings,
        mappings,
      );
      eligible = true;
      if (
        operation &&
        !disabled &&
        !jobs.some(
          (row) =>
            row.media_id === item.id &&
            ["queued", "running", "retrying"].includes(row.state),
        ) &&
        preMutationRetryProof(operation) &&
        JSON.parse(operation.evidence).scan.fingerprint ===
          validated.scan.fingerprint &&
        sameIdentity(
          JSON.parse(operation.evidence).identity,
          validated.identity,
        )
      )
        retryOperationId = operation.id;
    } catch {
      /* Never offer an action without conclusive persisted evidence. */
    }
    return {
      ...item,
      remediation: {
        mediaId: item.id,
        eligible: eligible && (!operation || !!retryOperationId),
        state: remediationState(operation?.state || job?.state),
        retryOperationId,
        reason: operation?.error
          ? remediationReason(operation.error, operation.source)
          : undefined,
        disabledReason:
          disabled ||
          ((operation || job) && !retryOperationId
            ? "An operation already exists for this evidence. Review its state in Jobs or Needs Attention; uncertain operations are never repeated."
            : undefined),
      },
    };
  });
}

export function attentionRemediation(subject: string) {
  const rows = raw()
    .prepare(
      `SELECT id FROM media_items WHERE id=? OR path=?
      UNION SELECT m.id FROM media_items m JOIN operations o ON o.source=m.source AND o.entity_id=m.arr_id
        AND o.file_id=CAST(m.identity AS INTEGER) WHERE o.id=? LIMIT 2`,
    )
    .all(subject, subject, subject) as { id: string }[];
  return rows.length === 1 ? manualRemediationControl(rows[0].id) : undefined;
}

export function queueManualRemediation(mediaId: string, actor: string) {
  return raw()
    .transaction(() => {
      requireRemediationAllowed();
      const { media, scan, identity } = loadManualRemediation(mediaId);
      const operation = operationFor(media);
      if (operation) return { state: remediationState(operation.state) };
      const payload = { mediaId, fingerprint: scan.fingerprint!, identity };
      const existing = raw()
        .prepare(
          "SELECT id,state FROM jobs WHERE kind='remediate' AND json_extract(payload,'$.mediaId')=? AND json_extract(payload,'$.fingerprint')=? ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get(mediaId, scan.fingerprint) as
        | { id: string; state: string }
        | undefined;
      if (existing)
        return { id: existing.id, state: remediationState(existing.state) };
      requireManualAdmission();
      const job = jobQueue.enqueue("remediate", payload);
      audit(
        "remediation",
        `Manual remediation queued for ${mediaId}: ${job.id}`,
        actor,
      );
      return { id: job.id, state: "Fixing" as const };
    })
    .immediate();
}

/** Explicit retry preserves the original operation and journals authorization.
 * The worker consumes it once; neither old evidence nor mutation records are erased. */
export async function queuePreMutationRetry(
  mediaId: string,
  operationId: string,
  actor: string,
) {
  requireRemediationAllowed();
  const { scan, identity } = loadManualRemediation(mediaId);
  const operation = raw()
    .prepare("SELECT * FROM operations WHERE id=?")
    .get(operationId) as RetryOperation | undefined;
  if (!operation) throw new Error("Operation not found");
  const prior = JSON.parse(operation.evidence);
  if (
    prior.scan.fingerprint !== scan.fingerprint ||
    prior.scan.path !== scan.path ||
    !sameIdentity(prior.identity, identity)
  )
    throw new Error(
      "Retry identity or evidence changed; manual inspection required",
    );
  const active = () =>
    raw()
      .prepare(
        `SELECT id FROM jobs WHERE kind='remediate' AND state IN ('queued','running','retrying')
    AND json_extract(payload,'$.mediaId')=?`,
      )
      .get(mediaId) as { id: string } | undefined;
  if (operation.state === "retry-queued" && active())
    return { id: active()!.id, state: "Fixing" as const };
  if (active() || !preMutationRetryProof(operation))
    throw new Error(
      "Operation is not proven pre-mutation; manual inspection required",
    );
  if (
    (await safeMediaPath(scan.path, roots())) !== scan.path ||
    (await fingerprint(scan.path, getSettings())) !== scan.fingerprint
  )
    throw new Error("Media or policy changed since scanning");
  await validateRemediationIdentity(scan, identity);
  if ((await fingerprint(scan.path, getSettings())) !== scan.fingerprint)
    throw new Error("Media or policy changed since scanning");
  return raw()
    .transaction(() => {
      requireRemediationAllowed();
      const fresh = loadManualRemediation(mediaId);
      const current = raw()
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(operationId) as RetryOperation;
      if (
        active() ||
        !preMutationRetryProof(current) ||
        fresh.scan.fingerprint !== scan.fingerprint ||
        !sameIdentity(fresh.identity, identity)
      )
        throw new Error("Retry proof changed; manual inspection required");
      requireManualAdmission("", operationId);
      const token = randomUUID();
      raw()
        .prepare(
          "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,'retry-authorized',?,?)",
        )
        .run(operationId, JSON.stringify({ token }), new Date().toISOString());
      raw()
        .prepare(
          "UPDATE operations SET state='retry-queued',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), operationId);
      const job = jobQueue.enqueue("remediate", {
        mediaId,
        fingerprint: scan.fingerprint,
        identity,
        retry: { operationId, token },
      });
      audit(
        "remediation",
        `Explicit pre-mutation retry authorized: ${operationId}; job ${job.id}`,
        actor,
      );
      return { id: job.id, state: "Fixing" as const };
    })
    .immediate();
}
