import { describe, expect, it, vi } from "vitest";
import { SonarrClient, RadarrClient } from "../src/lib/clients";
import type { ArrTransport } from "../src/lib/arr-transport";
import { correlateRelease } from "../src/lib/remediation-history";

describe("version-pinned Arr history contracts", () => {
  for (const source of ["sonarr", "radarr"] as const) {
    it.each([
      "valid",
      "missing",
      "mismatch",
      "traversal",
      "case",
      "incomplete-competitor",
      "shared-import",
    ])(`${source}: imported library path (%s)`, async (condition) => {
      const arrPath = "/tv/ALF/Season 04/ALF - S04E01.mkv";
      const identity = {
        source,
        entityId: 42,
        fileId: 123,
        seriesId: 7,
        arrPath,
      };
      const ref =
        source === "sonarr" ? { seriesId: 7, episodeId: 42 } : { movieId: 42 };
      const imported = {
        id: 11,
        ...ref,
        eventType: "downloadFolderImported",
        sourceTitle: "ALF.S04E01.RELEASE",
        downloadId: "exact-download",
        data: {
          droppedPath: "/downloads/complete/ALF.S04E01.RELEASE/ALF.S04E01.mkv",
          importedPath:
            condition === "missing"
              ? undefined
              : condition === "mismatch"
                ? "/tv/ALF/another.mkv"
                : condition === "traversal"
                  ? "/tv/../tv/ALF/Season 04/ALF - S04E01.mkv"
                  : condition === "case"
                    ? arrPath.toLowerCase()
                    : arrPath,
          releaseGroup: null,
          downloadClient: null,
        },
      };
      const grab = {
        id: 10,
        ...ref,
        eventType: "grabbed",
        sourceTitle: "ALF.S04E01.RELEASE",
        downloadId: "exact-download",
        quality: { quality: { id: 1 }, revision: { version: 1 } },
        data: {
          publishedDate: "2026-01-01T00:00:00Z",
          indexer: "Fixture Indexer",
          protocol: "2",
          size: "300000000",
          torrentInfoHash: "fixture-hash",
          imdbId: null,
          releaseGroup: null,
        },
      };
      const transport = vi.fn<ArrTransport>(async (url) => {
        if (url.searchParams.has("downloadId")) {
          expect(url.searchParams.get("downloadId")).toBe("exact-download");
          expect(url.searchParams.has("episodeId")).toBe(false);
          expect(url.searchParams.has("movieIds")).toBe(false);
          const records =
            condition === "shared-import"
              ? [
                  grab,
                  imported,
                  { ...imported, id: 99, episodeId: 999, movieId: 999 },
                ]
              : [grab, imported];
          return { records, totalRecords: records.length };
        }
        expect(
          url.searchParams.get(source === "sonarr" ? "episodeId" : "movieIds"),
        ).toBe("42");
        const records =
          condition === "incomplete-competitor"
            ? [imported, { ...imported, id: 12, downloadId: undefined }]
            : [imported];
        return { records, totalRecords: records.length };
      });
      const client =
        source === "sonarr"
          ? new SonarrClient("http://fixture.test", "fixture", transport)
          : new RadarrClient("http://fixture.test", "fixture", transport);
      if (condition === "valid") {
        expect((await correlateRelease(client, identity)).id).toBe(10);
        expect(transport).toHaveBeenCalledTimes(2);
      } else if (condition === "shared-import") {
        await expect(correlateRelease(client, identity)).rejects.toThrow(
          "multi-title download",
        );
        expect(transport).toHaveBeenCalledTimes(2);
      } else {
        await expect(correlateRelease(client, identity)).rejects.toThrow(
          "Ambiguous imported",
        );
        expect(transport).toHaveBeenCalledTimes(1);
      }
    });
  }
  it.each(["exceeded", "short", "duplicate", "changed-total"])(
    "bounded lookup refuses %s results",
    async (condition) => {
      const transport = vi.fn<ArrTransport>(async (url) => {
        const page = Number(url.searchParams.get("page"));
        const count = condition === "short" ? 99 : 100;
        return {
          records: Array.from({ length: count }, (_, i) => ({
            id: condition === "duplicate" ? i + 1 : (page - 1) * 100 + i + 1,
            eventType: "grabbed",
          })),
          totalRecords:
            condition === "exceeded"
              ? 1001
              : condition === "changed-total" && page === 2
                ? 201
                : 200,
        };
      });
      await expect(
        new SonarrClient("http://fixture.test", "fixture", transport).history({
          episodeId: 42,
        }),
      ).rejects.toThrow();
      expect(transport.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );
  it("paginates only the scoped history through the fixed 1000-record bound", async () => {
    const transport = vi.fn<ArrTransport>(async (url) => ({
      records: Array.from({ length: 100 }, (_, i) => ({
        id: (Number(url.searchParams.get("page")) - 1) * 100 + i + 1,
        eventType: "grabbed",
        sourceTitle: null,
        downloadId: null,
        data: { unrelated: null },
      })),
      totalRecords: 1000,
    }));
    expect(
      await new RadarrClient(
        "http://fixture.test",
        "fixture",
        transport,
      ).history({ movieId: 42 }),
    ).toHaveLength(1000);
    expect(transport).toHaveBeenCalledTimes(10);
    for (const [url] of transport.mock.calls)
      expect(url.searchParams.get("movieIds")).toBe("42");
  });
});
