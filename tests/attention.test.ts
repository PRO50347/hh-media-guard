import { describe, it, expect } from "vitest";
import { resolveAttention } from "../src/lib/attention";
import { raw, needsAttention, jobQueue } from "../src/lib/store";
import { reserveReplacement } from "../src/lib/retries";
const identity = {
  source: "sonarr",
  entityId: 701,
  seriesId: 70,
  fileId: 7001,
  arrPath: "/arr/test.mka",
};
function attention(subject: string, evidence: unknown) {
  needsAttention(subject, "fixture", evidence);
  return (
    raw().prepare("SELECT id FROM attention WHERE subject=?").get(subject) as {
      id: string;
    }
  ).id;
}
describe("administrator overrides", () => {
  it("pauses replacement on accept/ignore, resets budgets explicitly, and retries with full title identity", () => {
    const id = attention("override-fixture", { item: identity });
    resolveAttention(id, "ignore", "admin-fixture");
    expect(() => reserveReplacement("sonarr:701", "fixture-release")).toThrow(
      "ignored",
    );
    resolveAttention(id, "reset", "admin-fixture");
    expect(reserveReplacement("sonarr:701", "fixture-release")).toBe(1);
    resolveAttention(id, "accept", "admin-fixture");
    expect(() => reserveReplacement("sonarr:701", "another-release")).toThrow(
      "ignored",
    );
    resolveAttention(id, "retry", "admin-fixture");
    expect(
      jobQueue
        .list()
        .some(
          (job) =>
            job.kind === "scan-library" &&
            JSON.parse(job.payload).entityId === 701 &&
            JSON.parse(job.payload).seriesId === 70,
        ),
    ).toBe(true);
    expect(
      (
        raw().prepare("SELECT state FROM attention WHERE id=?").get(id) as {
          state: string;
        }
      ).state,
    ).toBe("accepted");
  });
  it("refuses reset without an Arr identity and retains evidence", () => {
    const id = attention("unidentified-fixture", { path: "/missing-fixture" });
    expect(() => resolveAttention(id, "reset", "admin-fixture")).toThrow(
      "identity",
    );
    resolveAttention(id, "rescan", "admin-fixture");
    expect(
      jobQueue
        .list()
        .some((job) => JSON.parse(job.payload).path === "/missing-fixture"),
    ).toBe(true);
  });
});
