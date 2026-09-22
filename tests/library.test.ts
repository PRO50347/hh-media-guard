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
