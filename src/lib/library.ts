import path from "node:path";
import type { RadarrClient, SonarrClient } from "./clients";
import { listMappings } from "./store";
import type { PathMapping } from "./types";

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
): Promise<LibraryFile[]> {
  const result: LibraryFile[] = [];
  signal?.throwIfAborted();
  for (const series of await client.series()) {
    signal?.throwIfAborted();
    if (scope.seriesId && scope.seriesId !== series.id) continue;
    const episodes = await client.episodes(series.id);
    signal?.throwIfAborted();
    const files = await client.episodeFiles(series.id);
    signal?.throwIfAborted();
    const byId = new Map(files.map((file) => [file.id, file]));
    for (const episode of episodes) {
      if (
        !episode.episodeFileId ||
        (scope.entityId && scope.entityId !== episode.id) ||
        (scope.season !== undefined && scope.season !== episode.seasonNumber)
      )
        continue;
      const file = byId.get(episode.episodeFileId);
      if (!file)
        throw new Error(
          `Sonarr file identity is inconsistent for episode ${episode.id}`,
        );
      if (file.seriesId && file.seriesId !== series.id)
        throw new Error("Sonarr file belongs to another series");
      result.push({
        source: "sonarr",
        entityId: episode.id,
        fileId: file.id,
        seriesId: series.id,
        season: episode.seasonNumber,
        episode: episode.episodeNumber,
        title: `${series.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")} — ${episode.title}`,
        arrPath: file.path,
      });
    }
  }
  return result;
}

export async function enumerateRadarr(
  client: Pick<RadarrClient, "movies" | "movieFiles">,
  scope: AuditScope = {},
  signal?: AbortSignal,
): Promise<LibraryFile[]> {
  const result: LibraryFile[] = [];
  signal?.throwIfAborted();
  for (const movie of await client.movies()) {
    signal?.throwIfAborted();
    if (scope.entityId && scope.entityId !== movie.id) continue;
    if (!movie.hasFile && !movie.movieFile) continue;
    const files = await client.movieFiles(movie.id);
    signal?.throwIfAborted();
    for (const file of files) {
      if (file.movieId && file.movieId !== movie.id)
        throw new Error("Radarr file belongs to another movie");
      result.push({
        source: "radarr",
        entityId: movie.id,
        fileId: file.id,
        title: movie.title,
        year: movie.year,
        arrPath: file.path,
      });
    }
    if (movie.hasFile && !files.length)
      throw new Error(
        `Radarr file identity is inconsistent for movie ${movie.id}`,
      );
  }
  return result;
}
