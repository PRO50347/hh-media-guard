import path from "node:path";
import type { RadarrClient, SonarrClient } from "./clients";
import { listMappings } from "./store";
import type { PathMapping, ArrLanguageEvidence } from "./types";

export interface LibraryFile {
  source: "sonarr" | "radarr";
  entityId: number;
  fileId: number;
  title: string;
  arrPath: string;
  seriesId?: number;
  season?: number;
  episode?: number;
  year?: number;
  languageEvidence?: ArrLanguageEvidence;
}
export interface AuditScope {
  source?: "sonarr" | "radarr";
  entityId?: number;
  seriesId?: number;
  season?: number;
  force?: boolean;
  filter?: "fail" | "needs-analysis";
}

export function translateArrPath(
  source: "sonarr" | "radarr",
  input: string,
  mappings: PathMapping[] = listMappings(),
) {
  if (
    !path.posix.isAbsolute(input) ||
    input.includes("\0") ||
    input.split("/").includes("..")
  )
    return undefined;
  const mapping = mappings
    .filter(
      (item) =>
        item.enabled && (item.source === source || item.source === "generic"),
    )
    .sort((a, b) => b.arrPath.length - a.arrPath.length)
    .find((item) => input.startsWith(`${item.arrPath.replace(/\/$/, "")}/`));
  if (!mapping) return undefined;
  const suffix = path.posix.relative(mapping.arrPath, input);
  return suffix.startsWith("..") || path.posix.isAbsolute(suffix)
    ? undefined
    : path.posix.join(mapping.containerPath, suffix);
}

export async function enumerateSonarr(
  client: Pick<SonarrClient, "series" | "episodes" | "episodeFiles">,
  scope: AuditScope = {},
  signal?: AbortSignal,
  progress?: (count: number) => void,
): Promise<LibraryFile[]> {
  const result: LibraryFile[] = [];
  const budget = { bytes: 0 };
  signal?.throwIfAborted();
  for (const series of uniqueRecords(
    await client.series(signal, scope.seriesId),
  )) {
    signal?.throwIfAborted();
    if (scope.seriesId && scope.seriesId !== series.id) continue;
    const episodes = await client.episodes(series.id, signal);
    signal?.throwIfAborted();
    const files = await client.episodeFiles(series.id, signal);
    signal?.throwIfAborted();
    const byId = new Map(uniqueRecords(files).map((file) => [file.id, file]));
    for (const episode of episodes) {
      if (
        !episode.episodeFileId ||
        (scope.entityId && scope.entityId !== episode.id) ||
        (scope.season !== undefined && scope.season !== episode.seasonNumber)
      )
        continue;
      if (episode.seriesId !== series.id)
        throw new Error("Sonarr episode belongs to another series");
      const file = byId.get(episode.episodeFileId);
      if (!file)
        throw new Error(
          `Sonarr file identity is inconsistent for episode ${episode.id}`,
        );
      if (file.seriesId && file.seriesId !== series.id)
        throw new Error("Sonarr file belongs to another series");
      if (result.length >= 100_000)
        throw new Error(
          "Arr library exceeds 100,000 media records; use a title-scoped audit",
        );
      appendFile(
        result,
        {
          source: "sonarr",
          entityId: episode.id,
          fileId: file.id,
          seriesId: series.id,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          title: `${series.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")} — ${episode.title}`,
          arrPath: file.path,
          ...(file.seriesId === series.id && file.languages?.length
            ? {
                languageEvidence: {
                  source: "sonarr" as const,
                  entityId: episode.id,
                  fileId: file.id,
                  arrPath: file.path,
                  languages: file.languages.map((l) => l.name),
                },
              }
            : {}),
        },
        budget,
      );
    }
    progress?.(result.length);
  }
  return uniqueFiles(result);
}

export async function enumerateRadarr(
  client: Pick<RadarrClient, "movies" | "movieFiles">,
  scope: AuditScope = {},
  signal?: AbortSignal,
  progress?: (count: number) => void,
): Promise<LibraryFile[]> {
  const result: LibraryFile[] = [];
  const budget = { bytes: 0 };
  signal?.throwIfAborted();
  for (const movie of uniqueRecords(
    await client.movies(signal, scope.entityId),
  )) {
    signal?.throwIfAborted();
    if (scope.entityId && scope.entityId !== movie.id) continue;
    if (!movie.hasFile && !movie.movieFile) continue;
    const files =
      movie.movieFile?.movieId === movie.id
        ? [movie.movieFile]
        : await client.movieFiles(movie.id, signal);
    signal?.throwIfAborted();
    for (const file of uniqueRecords(files)) {
      if (file.movieId && file.movieId !== movie.id)
        throw new Error("Radarr file belongs to another movie");
      if (result.length >= 100_000)
        throw new Error(
          "Arr library exceeds 100,000 media records; use a title-scoped audit",
        );
      appendFile(
        result,
        {
          source: "radarr",
          entityId: movie.id,
          fileId: file.id,
          title: movie.title,
          year: movie.year,
          arrPath: file.path,
          ...(file.movieId === movie.id && file.languages?.length
            ? {
                languageEvidence: {
                  source: "radarr" as const,
                  entityId: movie.id,
                  fileId: file.id,
                  arrPath: file.path,
                  languages: file.languages.map((l) => l.name),
                },
              }
            : {}),
        },
        budget,
      );
    }
    if (movie.hasFile && !files.length)
      throw new Error(
        `Radarr file identity is inconsistent for movie ${movie.id}`,
      );
    progress?.(result.length);
  }
  return uniqueFiles(result);
}

/** Never reuse evidence from another entity/file/path, including stored details. */
export function matchingFileEvidence(item: LibraryFile) {
  const e = item.languageEvidence;
  return e &&
    e.source === item.source &&
    e.entityId === item.entityId &&
    e.fileId === item.fileId &&
    e.arrPath === item.arrPath
    ? e
    : undefined;
}
function uniqueFiles(items: LibraryFile[]) {
  const unique = new Map<string, LibraryFile>();
  for (const item of items) {
    const key = `${item.source}:${item.entityId}:${item.fileId}`;
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item))
      throw new Error("Arr returned conflicting file identities");
    unique.set(key, item);
  }
  return [...unique.values()];
}

function uniqueRecords<T extends { id: number }>(records: T[]): T[] {
  const seen = new Map<number, T>();
  for (const record of records) {
    const prior = seen.get(record.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record))
      throw new Error("Arr returned conflicting duplicate records");
    seen.set(record.id, record);
  }
  return [...seen.values()];
}

function appendFile(
  result: LibraryFile[],
  item: LibraryFile,
  budget: { bytes: number },
) {
  budget.bytes += Buffer.byteLength(JSON.stringify(item));
  if (budget.bytes > 16_000_000)
    throw new Error(
      "Arr library exceeds 16 MB of retained file metadata; use a title-scoped audit",
    );
  result.push(item);
}
