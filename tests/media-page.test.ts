import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { raw, addMapping } from "../src/lib/store";
import { mediaPage } from "../src/lib/media-page";
import * as controls from "../src/lib/manual-remediation";

const rows = Array.from({ length: 4000 }, (_, i) => ({
  id: `media-${String(i).padStart(4, "0")}`,
  source: i % 2 ? "sonarr" : "radarr",
  index: i,
  title: `Fixture ${String(i).padStart(4, "0")}`,
  decision: i % 5 === 0 ? "fail" : "pass",
}));
beforeAll(() => {
  for (const source of ["sonarr", "radarr"] as const)
    addMapping({
      source,
      arrPath: `/${source}`,
      containerPath: `/fixture/${source}`,
      mediaType: "other",
      enabled: true,
    });
  const media = raw().prepare(
    "INSERT INTO media_items(id,source,arr_id,title,path,identity,fingerprint,decision,details) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const scans = raw().prepare(
    "INSERT INTO scans(path,fingerprint,decision,reason,data,scanned_at) VALUES(?,?,?,?,?,?)",
  );
  raw()
    .transaction(() => {
      for (const row of rows) {
        const path = `/fixture/${row.source}/file-${row.index}.mkv`;
        const fingerprint = `fingerprint-${row.index}`;
        const identity = {
          source: row.source,
          entityId: row.index + 1,
          fileId: row.index + 1,
          seriesId: 1,
          arrPath: `/${row.source}/file-${row.index}.mkv`,
        };
        media.run(
          row.id,
          row.source,
          row.index + 1,
          row.title,
          path,
          String(row.index + 1),
          fingerprint,
          row.decision,
          JSON.stringify(identity),
        );
        scans.run(
          path,
          fingerprint,
          row.decision,
          "fixture",
          JSON.stringify({
            path,
            fingerprint,
            decision: row.decision,
            duration: 100,
            tracks: [
              {
                language: "spa",
                duration: 100,
                isCommentary: false,
                isDescriptive: false,
              },
            ],
            scannedAt: "fixture",
          }),
          "fixture",
        );
      }
    })
    .immediate();
});
afterEach(() => vi.restoreAllMocks());

describe("bounded server-side media pages", () => {
  it.each(["sonarr", "radarr"] as const)(
    "%s filters in SQL and decorates only the current 25 failed rows",
    (source) => {
      const decorate = vi.spyOn(controls, "withRemediation");
      const queries = vi.spyOn(raw(), "prepare");
      const result = mediaPage(
        new URLSearchParams("status=fail&page=2"),
        source,
      );
      const expected = rows.filter(
        (row) => row.source === source && row.decision === "fail",
      );
      expect(result.total).toBe(expected.length);
      expect(result.items.map((row) => row.id)).toEqual(
        expected.slice(25, 50).map((row) => row.id),
      );
      expect(
        result.items.every(
          (row) => row.decision === "fail" && row.remediation.eligible,
        ),
      ).toBe(true);
      expect(decorate).toHaveBeenCalledTimes(1);
      expect(decorate.mock.calls[0][0]).toHaveLength(25);
      // Two page queries plus bounded media/scan, operations, jobs, settings/mapping batches.
      expect(queries.mock.calls.length).toBeLessThanOrEqual(8);
      expect(
        queries.mock.calls.some(
          ([sql]) =>
            sql.includes("LIMIT 25 OFFSET ?") && sql.includes("decision=?"),
        ),
      ).toBe(true);
    },
  );
  it("searches the full source library, preserves literal search text and clamps stale pages", () => {
    const result = mediaPage(
      new URLSearchParams("q=Fixture+399&status=pass&page=999"),
      "sonarr",
    );
    const expected = rows.filter(
      (row) =>
        row.source === "sonarr" &&
        row.decision === "pass" &&
        row.title.includes("Fixture 399"),
    );
    expect(result.items.map((row) => row.id)).toEqual(
      expected.map((row) => row.id),
    );
    expect(result.total).toBe(expected.length);
    expect(result.page).toBe(1);
    expect(mediaPage(new URLSearchParams("q=%25"), "sonarr").items).toEqual([]);
    expect(mediaPage(new URLSearchParams("page=NaN"), "radarr").page).toBe(1);
  });
  it("keeps unknown results ineligible and supports every existing action-state filter", () => {
    const id = rows[0].id;
    raw()
      .prepare("UPDATE media_items SET decision='needs-analysis' WHERE id=?")
      .run(id);
    const unknown = mediaPage(
      new URLSearchParams("status=needs-analysis"),
      "radarr",
    );
    expect(unknown.items).toHaveLength(1);
    expect(unknown.items[0].remediation.eligible).toBe(false);
    for (const state of ["needs-attention", "pending", "quarantined"]) {
      raw()
        .prepare("UPDATE media_items SET action_state=? WHERE id=?")
        .run(state, id);
      expect(
        mediaPage(new URLSearchParams(`status=${state}`), "radarr").items.map(
          (row) => row.id,
        ),
      ).toEqual([id]);
    }
  });
});
