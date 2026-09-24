import { describe, expect, it, vi } from "vitest";
import { SonarrClient, RadarrClient } from "../src/lib/clients";
import {
  permittedServiceAddress,
  serviceUrl,
  type ArrTransport,
} from "../src/lib/arr-transport";
import {
  enumerateSonarr,
  enumerateRadarr,
  translateArrPath,
} from "../src/lib/library";
import type { PathMapping } from "../src/lib/types";

describe("Arr API contracts", () => {
  it("joins Sonarr episodeFileId to the episodefile endpoint", async () => {
    const transport: ArrTransport = vi.fn(async (url) => {
      if (url.pathname.endsWith("/series"))
        return [{ id: 1, title: "Fixture Show" }];
      if (url.pathname.endsWith("/episode"))
        return [
          {
            id: 12,
            seriesId: 1,
            episodeFileId: 4,
            seasonNumber: 2,
            episodeNumber: 3,
            title: "Fixture",
          },
        ];
      if (url.pathname.endsWith("/episodefile"))
        return [{ id: 4, seriesId: 1, path: "/data/tv/fixture.mkv" }];
      throw new Error("Unexpected request");
    });
    const files = await enumerateSonarr(
      new SonarrClient("http://sonarr.test/base", "mock-key", transport),
    );
    expect(files).toEqual([
      {
        source: "sonarr",
        entityId: 12,
        fileId: 4,
        seriesId: 1,
        season: 2,
        episode: 3,
        title: "Fixture Show S02E03 — Fixture",
        arrPath: "/data/tv/fixture.mkv",
      },
    ]);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/base/api/v3/episodefile" }),
      "mock-key",
      "GET",
      undefined,
      expect.objectContaining({ project: expect.any(Function) }),
    );
  });
  it("enumerates Radarr moviefile resources", async () => {
    const transport: ArrTransport = async (url) =>
      url.pathname.endsWith("/movie")
        ? [{ id: 5, title: "Fixture Movie", year: 2026, hasFile: true }]
        : [{ id: 6, movieId: 5, path: "/movies/fixture.mkv" }];
    expect(
      await enumerateRadarr(
        new RadarrClient("http://radarr.test", "mock", transport),
      ),
    ).toEqual([
      {
        source: "radarr",
        entityId: 5,
        fileId: 6,
        title: "Fixture Movie",
        year: 2026,
        arrPath: "/movies/fixture.mkv",
      },
    ]);
  });
  it("reports inconsistent identity rather than skipping imported media", async () => {
    await expect(
      enumerateSonarr({
        series: async () => [{ id: 1, title: "Show" }],
        episodes: async () => [
          {
            id: 2,
            seriesId: 1,
            episodeFileId: 3,
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Episode",
          },
        ],
        episodeFiles: async () => [],
      }),
    ).rejects.toThrow("inconsistent");
  });
  it("filters a selected season", async () => {
    const client = {
      series: async () => [{ id: 1, title: "Show" }],
      episodes: async () => [
        {
          id: 2,
          seriesId: 1,
          episodeFileId: 3,
          seasonNumber: 1,
          episodeNumber: 1,
          title: "Episode",
        },
      ],
      episodeFiles: async () => [{ id: 3, path: "/tv/a.mkv" }],
    };
    expect(await enumerateSonarr(client, { season: 2 })).toEqual([]);
  });
  it("parses paged history records", async () => {
    const transport: ArrTransport = vi.fn(async () => ({
      records: [{ id: 1, eventType: "grabbed", downloadId: "test-download" }],
      totalRecords: 1,
    }));
    expect(
      await new SonarrClient("http://sonarr.test", "mock", transport).history(),
    ).toHaveLength(1);
  });
  it.each([401, 404, 500])(
    "propagates a sanitized HTTP %s failure",
    async (status) => {
      const transport: ArrTransport = async () => {
        throw new Error(`Arr request failed with HTTP ${status}`);
      };
      await expect(
        new RadarrClient(
          "http://radarr.test",
          "secret-value",
          transport,
        ).testConnection(),
      ).rejects.toThrow(String(status));
    },
  );
  it("blocks destructive clients before invoking transport in Monitor Only", async () => {
    const transport: ArrTransport = vi.fn();
    const client = new SonarrClient("http://sonarr.test", "mock", transport);
    await expect(client.deleteEpisodeFile(1)).rejects.toThrow("disabled");
    await expect(client.searchEpisode([1])).rejects.toThrow("disabled");
    await expect(client.markHistoryFailed(1)).rejects.toThrow("disabled");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("Arr network boundaries", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "100.100.100.200",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "ff02::1",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:7f00:1",
    "2002:7f00:1::",
    "2001:0:1::1",
    "64:ff9b::7f00:1",
    "not-an-address",
  ])("blocks %s", (address) =>
    expect(permittedServiceAddress(address)).toBe(false),
  );
  it.each([
    "10.1.2.3",
    "192.168.5.2",
    "172.18.0.3",
    "fd00::1234",
    "fc00:0:0:0:0:0:0:1",
    "2606:4700:4700::1111",
    "8.8.8.8",
  ])("allows explicitly configured LAN services %s", (address) =>
    expect(permittedServiceAddress(address)).toBe(true),
  );
  it.each([
    "file:///tmp/test",
    "http://user:pass@service.test",
    "http://service.test?key=secret",
    "http://localhost",
    "http://127.1",
  ])("rejects unsafe base URL %s", (url) =>
    expect(() => serviceUrl(url)).toThrow(),
  );
});

describe("mapping translation", () => {
  const mapping: PathMapping = {
    id: "test",
    source: "sonarr",
    arrPath: "/data/tv",
    containerPath: "/tv",
    mediaType: "tv",
    enabled: true,
  };
  it("translates Unicode paths", () =>
    expect(
      translateArrPath("sonarr", "/data/tv/日本語 space.mkv", [mapping]),
    ).toBe("/tv/日本語 space.mkv"));
  it.each([
    "/data/tv2/a.mkv",
    "/data/tv/../secret",
    "/etc/passwd",
    "relative/path",
  ])("rejects %s", (input) =>
    expect(translateArrPath("sonarr", input, [mapping])).toBeUndefined(),
  );
  it("does not use a disabled mapping", () =>
    expect(
      translateArrPath("sonarr", "/data/tv/a.mkv", [
        { ...mapping, enabled: false },
      ]),
    ).toBeUndefined());
});

describe("connection service identity", () => {
  it.each(["sonarr", "radarr"] as const)(
    "requires genuine %s API v3 identity",
    async (service) => {
      const other = service === "sonarr" ? "Radarr" : "Sonarr";
      for (const response of [
        { version: "4.0.0" },
        { version: "4.0.0", appName: other },
        { version: "4.0.0 secret-value", appName: service },
      ]) {
        await expect(
          new SonarrClient(
            "http://fixture.test",
            "secret-value",
            async () => response,
          ).testConnection(service),
        ).rejects.toThrow(/Unexpected|Wrong service/);
      }
    },
  );
  it.each([
    "http://fixture.test",
    "http://fixture.test/",
    "https://fixture.test/base",
    "https://fixture.test/base/",
  ])("joins base path %s without changing the key", async (url) => {
    const transport: ArrTransport = vi.fn(async () => ({
      version: "4.0.0.1",
      appName: "Sonarr",
    }));
    await new SonarrClient(
      url,
      "exact+plaintext/key",
      transport,
    ).testConnection("sonarr");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: url.includes("/base")
          ? "/base/api/v3/system/status"
          : "/api/v3/system/status",
      }),
      "exact+plaintext/key",
      "GET",
      undefined,
    );
  });
});

it("rejects wrong series/movie associations and conflicting duplicate file records", async () => {
  const base = {
    series: async () => [{ id: 1, title: "Show" }],
    episodes: async () => [
      {
        id: 2,
        seriesId: 1,
        episodeFileId: 3,
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Episode",
      },
    ],
    episodeFiles: async () => [
      {
        id: 3,
        seriesId: 9,
        path: "/tv/a",
        languages: [{ id: 1, name: "English" }],
      },
    ],
  };
  await expect(enumerateSonarr(base)).rejects.toThrow("another series");
  await expect(
    enumerateSonarr({
      ...base,
      episodeFiles: async () => [
        { id: 3, seriesId: 1, path: "/tv/a" },
        { id: 3, seriesId: 1, path: "/tv/b" },
      ],
    }),
  ).rejects.toThrow("conflicting");
  await expect(
    enumerateRadarr({
      movies: async () => [{ id: 1, title: "Movie", hasFile: true }],
      movieFiles: async () => [
        {
          id: 3,
          movieId: 9,
          path: "/movies/a",
          languages: [{ id: 1, name: "English" }],
        },
      ],
    }),
  ).rejects.toThrow("another movie");
});
it("deduplicates repeated identical titles and files without duplicate requests/results", async () => {
  const movie = { id: 1, title: "Movie", hasFile: true };
  const file = { id: 3, movieId: 1, path: "/movies/a" };
  const movieFiles = vi.fn(async () => [file, file]);
  expect(
    await enumerateRadarr({ movies: async () => [movie, movie], movieFiles }),
  ).toHaveLength(1);
  expect(movieFiles).toHaveBeenCalledTimes(1);
});
it("does not attach file-language fallback without a matching parent identity", async () => {
  const files = await enumerateRadarr({
    movies: async () => [{ id: 1, title: "Movie", hasFile: true }],
    movieFiles: async () => [
      { id: 3, path: "/movies/a", languages: [{ id: 1, name: "English" }] },
    ],
  });
  expect(files[0].languageEvidence).toBeUndefined();
});
it("uses bounded single-title routes when a scope supplies its identity", async () => {
  const sonarr: ArrTransport = vi.fn(async () => ({ id: 3, title: "Show" }));
  const radarr: ArrTransport = vi.fn(async () => ({ id: 5, title: "Movie" }));
  await new SonarrClient("http://fixture.test/base", "key", sonarr).series(
    undefined,
    3,
  );
  await new RadarrClient("http://fixture.test/base", "key", radarr).movies(
    undefined,
    5,
  );
  expect(sonarr).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: "/base/api/v3/series/3" }),
    "key",
    "GET",
    undefined,
    { signal: undefined },
  );
  expect(radarr).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: "/base/api/v3/movie/5" }),
    "key",
    "GET",
    undefined,
    { signal: undefined },
  );
});
