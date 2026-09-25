import { z } from "zod";
import { raw, getSettings, jobQueue, audit } from "./store";
import { translateArrPath } from "./library";
import { decideAudio } from "./rules";
import { requireRemediationAllowed } from "./remediation";
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
  if (getSettings().safetyMode !== "automatic")
    return "Remediation is disabled: select Automatic mode in Settings to allow quarantine and redownload.";
}

function mediaRow(mediaId: string) {
  return raw().prepare("SELECT * FROM media_items WHERE id=?").get(mediaId) as
    | {
        id: string;
        source: string;
        arr_id: number;
        identity: string;
        path: string;
        fingerprint: string;
        decision: string;
        details: string;
      }
    | undefined;
}

/** The browser supplies only a media ID. Neither scan evidence nor Arr identity
 * from a request can authorize remediation. Re-read this again in the worker. */
export function loadManualRemediation(mediaId: string) {
  const media = mediaRow(mediaId);
  if (!media || media.decision !== "fail" || !media.fingerprint)
    throw new Error(
      "A persisted conclusive failed scan is required. Rescan this file first.",
    );
  const identity = identitySchema.parse(JSON.parse(media.details));
  if (
    identity.source !== media.source ||
    identity.entityId !== media.arr_id ||
    String(identity.fileId) !== media.identity ||
    translateArrPath(identity.source, identity.arrPath) !== media.path
  )
    throw new Error("Exact Arr file identity does not match persisted media.");
  const stored = raw()
    .prepare("SELECT data FROM scans WHERE fingerprint=? AND decision='fail'")
    .get(media.fingerprint) as { data: string } | undefined;
  if (!stored) throw new Error("Persisted failed evidence is unavailable.");
  const scan = JSON.parse(stored.data) as ScanResult;
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
    decideAudio(scan.duration, scan.tracks, getSettings(), arr).decision !==
    "fail"
  )
    throw new Error(
      "Stored evidence is no longer a conclusive failure. Rescan first.",
    );
  return { media, scan, identity };
}

function operationFor(media: NonNullable<ReturnType<typeof mediaRow>>) {
  return raw()
    .prepare(
      `SELECT id,state FROM operations WHERE source=? AND entity_id=?
    AND ((file_id=? AND json_extract(evidence,'$.scan.fingerprint')=?) OR state='pending'
      OR (state='complete' AND ?='pass')) ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(
      media.source,
      media.arr_id,
      Number(media.identity),
      media.fingerprint,
      media.decision,
    ) as { id: string; state: string } | undefined;
}

export function manualRemediationControl(mediaId: string): RemediationControl {
  const media = mediaRow(mediaId);
  const operation = media && operationFor(media);
  const job =
    media &&
    (raw()
      .prepare(
        `SELECT state FROM jobs WHERE kind='remediate'
    AND json_extract(payload,'$.mediaId')=? AND json_extract(payload,'$.fingerprint')=?
    ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(mediaId, media.fingerprint) as { state: string } | undefined);
  let eligible = false;
  try {
    loadManualRemediation(mediaId);
    eligible = true;
  } catch {
    /* Offer only exact, conclusive evidence. */
  }
  const state = remediationState(operation?.state || job?.state);
  return {
    mediaId,
    eligible,
    state,
    disabledReason:
      remediationDisabledReason() ||
      (operation || job
        ? "An operation already exists for this evidence. Review its state in Jobs or Needs Attention; uncertain operations are never repeated."
        : undefined),
  };
}

export function withRemediation<T extends { id: string }>(items: T[]) {
  return items.map((item) => ({
    ...item,
    remediation: manualRemediationControl(item.id),
  }));
}

export function attentionRemediation(subject: string) {
  const rows = raw()
    .prepare("SELECT id FROM media_items WHERE id=? OR path=? LIMIT 2")
    .all(subject, subject) as { id: string }[];
  return rows.length === 1 ? manualRemediationControl(rows[0].id) : undefined;
}

export function queueManualRemediation(mediaId: string, actor: string) {
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
  const job = jobQueue.enqueue("remediate", payload);
  audit(
    "remediation",
    `Manual remediation queued for ${mediaId}: ${job.id}`,
    actor,
  );
  return { id: job.id, state: "Fixing" as const };
}
