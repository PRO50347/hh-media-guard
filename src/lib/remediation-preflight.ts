import { lstat } from "node:fs/promises";
import { SonarrClient, type RadarrClient } from "./clients";
import { fingerprint, scanFile } from "./scanner";
import { getSettings, raw, roots, saveScan } from "./store";
import { safeMediaPath } from "./security";
import { translateArrPath } from "./library";
import type { MediaIdentity } from "./remediation";

export type RemediationClient = SonarrClient | RadarrClient;
export async function exactCurrentFile(
  identity: MediaIdentity,
  client: RemediationClient,
) {
  const file =
    client instanceof SonarrClient
      ? await client.findEpisodeFile(identity.fileId)
      : await client.findMovieFile(identity.fileId);
  if (
    !file ||
    file.id !== identity.fileId ||
    file.path !== identity.arrPath ||
    (identity.source === "sonarr"
      ? file.seriesId !== identity.seriesId
      : file.movieId !== identity.entityId)
  )
    throw new Error("Current Arr file identity changed; rescan before fixing");
  if (client instanceof SonarrClient) {
    const episodes = (await client.episodes(identity.seriesId!)).filter(
      (e) => e.episodeFileId === identity.fileId,
    );
    if (
      episodes.length !== 1 ||
      episodes[0].id !== identity.entityId ||
      episodes[0].seriesId !== identity.seriesId
    )
      throw new Error(
        "Single-episode identity is required; multi-episode files need manual attention",
      );
  } else {
    const files = await client.movieFiles(identity.entityId);
    if (
      files.length !== 1 ||
      files[0].id !== file.id ||
      files[0].path !== file.path ||
      files[0].movieId !== identity.entityId
    )
      throw new Error(
        "Current Arr file identity changed; rescan before fixing",
      );
  }
  return file;
}
export async function freshRemediationScan(
  identity: MediaIdentity,
  client: RemediationClient,
  signal?: AbortSignal,
) {
  const file = await exactCurrentFile(identity, client);
  const mapped = translateArrPath(identity.source, file.path);
  if (!mapped || (await safeMediaPath(mapped, roots())) !== mapped)
    throw new Error("Current media path is unsafe or unavailable");
  const scan = await scanFile(mapped, signal, {
    source: identity.source,
    entityId: identity.entityId,
    fileId: file.id,
    arrPath: file.path,
    languages: (file.languages || []).map((language) => language.name),
  });
  // Refresh exact-file evidence after inspection as well: a concurrent Arr
  // replacement/metadata update must not authorize deletion of a different file.
  const after = await exactCurrentFile(identity, client);
  if (
    JSON.stringify(after.languages || []) !==
      JSON.stringify(file.languages || []) ||
    (await fingerprint(mapped, getSettings())) !== scan.fingerprint
  )
    throw new Error("Media or policy changed since scanning");
  saveScan(scan);
  raw()
    .prepare(
      "UPDATE media_items SET fingerprint=?,decision=?,last_scanned_at=?,identity=?,details=json_patch(details,?) WHERE source=? AND arr_id=? AND path=?",
    )
    .run(
      scan.fingerprint,
      scan.decision,
      scan.scannedAt,
      String(identity.fileId),
      JSON.stringify(identity),
      identity.source,
      identity.entityId,
      mapped,
    );
  return scan;
}
export async function verifyArrDeletion(
  identity: MediaIdentity,
  client: RemediationClient,
  activePath: string,
) {
  const old =
    client instanceof SonarrClient
      ? await client.findEpisodeFile(identity.fileId)
      : await client.findMovieFile(identity.fileId);
  const files =
    client instanceof SonarrClient
      ? await client.episodeFiles(identity.seriesId!)
      : await client.movieFiles(identity.entityId);
  if (
    old ||
    files.some(
      (file) => file.id === identity.fileId || file.path === identity.arrPath,
    )
  )
    throw new Error("Arr still reports the old file; inspection required");
  try {
    await lstat(activePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Active file still exists after Arr deletion; inspection required",
  );
}
