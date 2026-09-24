import { SafeError } from "./safe-error";
import { z } from "zod";
import { arrTransport, serviceUrl, type ArrTransport } from "./arr-transport";
import { getSettings } from "./store";

const id = z.number().int().positive();
const fileSchema = z.object({
  id,
  path: z.string().min(1).max(4096),
  languages: z
    .array(z.object({ id: z.number().int(), name: z.string().max(80) }))
    .max(32)
    .optional(),
  size: z.number().optional(),
  seriesId: id.optional(),
  movieId: id.optional(),
  relativePath: z.string().optional(),
});
const seriesSchema = z.object({
  id,
  title: z.string().max(1024),
  path: z.string().optional(),
});
const episodeSchema = z.object({
  id,
  seriesId: id,
  episodeFileId: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string().max(1024),
});
const movieSchema = z.object({
  id,
  title: z.string().max(1024),
  year: z.number().optional(),
  hasFile: z.boolean().optional(),
  movieFile: fileSchema.optional(),
});
const historySchema = z.object({
  id,
  eventType: z.string(),
  sourceTitle: z.string().optional(),
  downloadId: z.string().optional(),
  movieId: id.optional(),
  episodeId: id.optional(),
  data: z.record(z.string()).optional(),
});
export type ArrFile = z.infer<typeof fileSchema>;
export type ArrHistory = z.infer<typeof historySchema>;
export type Series = z.infer<typeof seriesSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type Movie = z.infer<typeof movieSchema>;
export interface ArrStatus {
  version: string;
  appName?: string;
}

export class ArrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly transport: ArrTransport = arrTransport,
  ) {}
  protected async request(
    endpoint: string,
    method = "GET",
    body?: unknown,
    options?: Parameters<ArrTransport>[4],
  ): Promise<unknown> {
    if (
      method !== "GET" &&
      (process.env.ALLOW_DESTRUCTIVE_ACTIONS !== "true" ||
        getSettings().safetyMode !== "automatic")
    )
      throw new Error("Arr mutation is disabled in the current safety mode");
    const base = serviceUrl(this.baseUrl);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v3${endpoint.split("?")[0]}`;
    base.search = endpoint.split("?")[1] || "";
    return options
      ? this.transport(base, this.apiKey, method, body, options)
      : this.transport(base, this.apiKey, method, body);
  }
  protected async list<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    return z
      .array(schema)
      .max(100_000)
      .parse(
        await this.request(endpoint, "GET", undefined, {
          signal,
          project: (value) => schema.parse(value),
        }),
      );
  }
  async testConnection(expected?: "sonarr" | "radarr"): Promise<ArrStatus> {
    const response = await this.request("/system/status");
    const parsed = z
      .object({
        version: z
          .string()
          .max(64)
          .regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/),
        appName: z.string(),
      })
      .safeParse(response);
    if (!parsed.success)
      throw new SafeError(
        "arr.response",
        "Unexpected or unsupported Arr API v3 status response; check the URL base/path and service version.",
      );
    if (expected && parsed.data.appName.toLowerCase() !== expected)
      throw new SafeError(
        "arr.service",
        `Wrong service response; expected ${expected === "sonarr" ? "Sonarr" : "Radarr"}. Check the server URL and port.`,
      );
    return parsed.data;
  }
  async history(): Promise<ArrHistory[]> {
    const result: ArrHistory[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = z
        .object({ records: z.array(historySchema), totalRecords: z.number() })
        .parse(
          await this.request(
            `/history?page=${page}&pageSize=100&sortKey=date&sortDirection=descending`,
          ),
        );
      result.push(...data.records);
      if (result.length >= data.totalRecords || !data.records.length)
        return result;
    }
    throw new Error("Arr history exceeds the supported page limit");
  }
  async queue() {
    return this.request("/queue?pageSize=100");
  }
  async downloadHandling() {
    return z
      .object({ autoRedownloadFailed: z.boolean() })
      .parse(await this.request("/config/downloadclient"));
  }
  async commandStatus(commandId: number) {
    return z
      .object({ id, status: z.string() })
      .parse(await this.request(`/command/${id.parse(commandId)}`));
  }
  async command(name: string, payload: Record<string, unknown> = {}) {
    return this.request("/command", "POST", { name, ...payload });
  }
  async markHistoryFailed(historyId: number) {
    return this.request(`/history/failed/${id.parse(historyId)}`, "POST");
  }
}
export class SonarrClient extends ArrClient {
  async series(signal?: AbortSignal, seriesId?: number) {
    if (seriesId)
      return [
        seriesSchema.parse(
          await this.request(
            `/series/${id.parse(seriesId)}`,
            "GET",
            undefined,
            { signal },
          ),
        ),
      ];
    return this.list("/series", seriesSchema, signal);
  }
  async episodes(seriesId: number, signal?: AbortSignal) {
    return this.list(
      `/episode?seriesId=${id.parse(seriesId)}`,
      episodeSchema,
      signal,
    );
  }
  async episodeFiles(seriesId: number, signal?: AbortSignal) {
    return this.list(
      `/episodefile?seriesId=${id.parse(seriesId)}`,
      fileSchema,
      signal,
    );
  }
  async episodeFile(fileId: number) {
    return fileSchema.parse(
      await this.request(`/episodefile/${id.parse(fileId)}`),
    );
  }
  async deleteEpisodeFile(fileId: number) {
    return this.request(`/episodefile/${id.parse(fileId)}`, "DELETE");
  }
  async searchEpisode(episodeIds: number[]) {
    return this.command("EpisodeSearch", {
      episodeIds: z.array(id).min(1).parse(episodeIds),
    });
  }
}
export class RadarrClient extends ArrClient {
  async movies(signal?: AbortSignal, movieId?: number) {
    if (movieId)
      return [
        movieSchema.parse(
          await this.request(`/movie/${id.parse(movieId)}`, "GET", undefined, {
            signal,
          }),
        ),
      ];
    return this.list("/movie", movieSchema, signal);
  }
  async movieFiles(movieId: number, signal?: AbortSignal) {
    return this.list(
      `/moviefile?movieId=${id.parse(movieId)}`,
      fileSchema,
      signal,
    );
  }
  async movieFile(fileId: number) {
    return fileSchema.parse(
      await this.request(`/moviefile/${id.parse(fileId)}`),
    );
  }
  async deleteMovieFile(fileId: number) {
    return this.request(`/moviefile/${id.parse(fileId)}`, "DELETE");
  }
  async searchMovie(movieIds: number[]) {
    return this.command("MoviesSearch", {
      movieIds: z.array(id).min(1).parse(movieIds),
    });
  }
}
