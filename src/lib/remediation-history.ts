import path from "node:path";
import type { ArrHistory, ArrBlocklist, ArrClient } from "./clients";
import type { MediaIdentity } from "./remediation";

const usable = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value === value.trim();
function libraryPath(value: unknown) {
  // Arr paths are compared in Arr's namespace, never resolved against our host.
  if (
    !usable(value) ||
    value.length > 4096 ||
    /[\x00-\x1f\\]/.test(value) ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.split("/").includes("..")
  )
    return undefined;
  return path.posix.normalize(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const related = (h: ArrHistory, identity: MediaIdentity) =>
  identity.source === "radarr"
    ? h.movieId === identity.entityId
    : h.seriesId === identity.seriesId && h.episodeId === identity.entityId;

function releaseEvidence(h: ArrHistory) {
  const data = h.data || {};
  if (
    !usable(h.sourceTitle) ||
    !usable(h.downloadId) ||
    !usable(data.indexer) ||
    !usable(data.publishedDate) ||
    !Number.isFinite(Date.parse(data.publishedDate)) ||
    typeof data.size !== "string" ||
    !/^\d+$/.test(data.size) ||
    !["1", "2"].includes(String(data.protocol)) ||
    typeof data.protocol !== "string" ||
    !h.quality ||
    typeof h.quality !== "object"
  )
    throw new Error("Grabbed release lacks required blocklist evidence");
  return canonical({
    title: h.sourceTitle,
    download: h.downloadId,
    quality: h.quality,
    indexer: data.indexer,
    publishedDate: data.publishedDate,
    size: data.size,
    protocol: data.protocol,
    torrentInfoHash: data.torrentInfoHash,
    guid: data.guid,
  });
}

export async function correlateRelease(
  client: ArrClient,
  identity: MediaIdentity,
) {
  const target = libraryPath(identity.arrPath);
  if (!target) throw new Error("Ambiguous imported release history");
  const history = await client.history(
    identity.source === "sonarr"
      ? { episodeId: identity.entityId }
      : { movieId: identity.entityId },
  );
  // Do not silently discard incomplete import evidence and select another event.
  const imports = history.filter(
    (h) => h.eventType === "downloadFolderImported",
  );
  if (
    imports.some(
      (h) =>
        !related(h, identity) ||
        !libraryPath(h.data?.importedPath) ||
        !usable(h.downloadId) ||
        !usable(h.sourceTitle),
    )
  )
    throw new Error("Ambiguous imported release history");
  const matching = imports.filter(
    (h) => libraryPath(h.data?.importedPath) === target,
  );
  const downloads = new Set(matching.map((h) => h.downloadId));
  if (
    !matching.length ||
    downloads.size !== 1 ||
    (identity.downloadId !== undefined &&
      !matching.every((h) => h.downloadId === identity.downloadId))
  )
    throw new Error("Ambiguous imported release history");
  const downloadId = matching[0].downloadId!;
  // Deliberately NOT scoped by episode/movie: a shared download must remain visible.
  const downloadHistory = await client.history({ downloadId });
  if (
    downloadHistory.some(
      (h) => h.downloadId !== downloadId || !related(h, identity),
    )
  )
    throw new Error("Ambiguous release identity or multi-title download");
  const grabs = downloadHistory.filter((h) => h.eventType === "grabbed");
  if (
    !grabs.length ||
    grabs.some((h) => !related(h, identity)) ||
    new Set(grabs.map(releaseEvidence)).size !== 1
  )
    throw new Error("Ambiguous release identity or multi-title download");
  return grabs[0];
}

/** Arr v4/v6 blocklist resources expose no downloadId/hash. This corroborates
 * a NEW entry using every available release discriminator, not a hash proof.
 * Never use an old matching entry or an uncertain POST outcome to authorize search. */
export function corroborateBlocklist(
  before: ArrBlocklist[],
  after: ArrBlocklist[],
  release: ArrHistory,
  identity: MediaIdentity,
) {
  const oldIds = new Set(before.map((row) => row.id));
  if (before.some((row) => !after.some((next) => next.id === row.id)))
    throw new Error(
      "Blocklist creation could not be verified; search withheld",
    );
  const matches = after.filter(
    (row) =>
      !oldIds.has(row.id) &&
      row.sourceTitle === release.sourceTitle &&
      row.indexer === release.data!.indexer &&
      row.protocol ===
        (release.data!.protocol === "1" ? "usenet" : "torrent") &&
      canonical(row.quality) === canonical(release.quality) &&
      (identity.source === "radarr"
        ? row.movieId === identity.entityId
        : row.seriesId === identity.seriesId &&
          row.episodeIds?.length === 1 &&
          row.episodeIds[0] === identity.entityId),
  );
  if (matches.length !== 1)
    throw new Error(
      "Blocklist creation could not be verified; search withheld",
    );
  return matches[0].id;
}
