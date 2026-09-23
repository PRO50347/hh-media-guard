import { describe, expect, it } from "vitest";
import { translateArrPath } from "../src/lib/library";

describe("Arr path translation", () => {
  it("returns undefined without an approved mapping", () =>
    expect(translateArrPath("sonarr", "/data/tv/file.mkv")).toBeUndefined());
  it("does not allow traversal-like source mapping output", () =>
    expect(
      translateArrPath("radarr", "/unmapped/../etc/passwd"),
    ).toBeUndefined());
});

it("stops enumeration between Arr requests when cancelled", async () => {
  const { enumerateSonarr } = await import("../src/lib/library");
  const controller = new AbortController();
  let fileRequests = 0;
  await expect(
    enumerateSonarr(
      {
        series: async () => [{ id: 1, title: "fixture" }],
        episodes: async () => {
          controller.abort();
          return [];
        },
        episodeFiles: async () => {
          fileRequests++;
          return [];
        },
      },
      {},
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fileRequests).toBe(0);
});
