import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { attentionQueue } from "../src/lib/attention-query";
import {
  attentionDetails,
  attentionFilters,
  filterAttention,
  type AttentionItem,
} from "../src/lib/attention-view";

function fixture() {
  let db: Pick<Database.Database, "exec" | "prepare" | "close">;
  try {
    db = new Database(":memory:");
  } catch (error) {
    // Local dependencies may contain a musl binary. Node 22's built-in SQLite
    // runs the same SQL fixtures without rebuilding dependencies; Node 20 uses
    // the application's native driver above.
    if ((error as { code?: string }).code !== "ERR_DLOPEN_FAILED") throw error;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    db = new DatabaseSync(":memory:");
  }
  db.exec(`
    CREATE TABLE attention (id TEXT PRIMARY KEY, subject TEXT, reason TEXT, evidence TEXT, state TEXT, created_at TEXT);
    CREATE TABLE media_items (id TEXT PRIMARY KEY, title TEXT, source TEXT);
    CREATE TABLE operations (id TEXT PRIMARY KEY, evidence TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT);
  `);
  return db;
}

describe("full-dataset attention queue", () => {
  it("counts all 3,889 rows and pages matching records beyond the old 500-row limit", () => {
    const db = fixture();
    try {
      const insert = db.prepare(
        "INSERT INTO attention VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < 3889; i++) {
        insert.run(
          String(i).padStart(4, "0"),
          `subject-${i}`,
          i < 3000 ? "missing required language" : "unknown language",
          JSON.stringify({ item: { source: i % 2 ? "sonarr" : "radarr" } }),
          i < 3800 ? "open" : "ignored",
          "2026-09-25",
        );
      }
      const first = attentionQueue(db, new URLSearchParams());
      expect(first.summary).toEqual({ open: 3800, ignored: 89, accepted: 0 });
      expect(first.total).toBe(3800);
      expect(first.mediaCounts).toEqual({ all: 3800, movies: 1900, tv: 1900 });
      expect(first.items).toHaveLength(25);
      const later = attentionQueue(
        db,
        new URLSearchParams("reason=needs-analysis&media=tv&page=2"),
      );
      expect(later.mediaCounts).toEqual({ all: 800, movies: 400, tv: 400 });
      expect(later.total).toBe(400);
      expect(later.pages).toBe(16);
      expect(later.items).toHaveLength(25);
      expect(later.items[0].id).toBe("3051");
      const ignored = attentionQueue(
        db,
        new URLSearchParams(
          "status=ignored&reason=needs-analysis&media=movies&page=999",
        ),
      );
      expect(ignored.total).toBe(45);
      expect(ignored.page).toBe(2);
      expect(ignored.items).toHaveLength(20);
      const all = attentionQueue(db, new URLSearchParams("status=all"));
      expect(all.total).toBe(3889);
      expect(all.items).toHaveLength(25);
      const empty = attentionQueue(
        db,
        new URLSearchParams("reason=scanner-failure"),
      );
      expect(empty.total).toBe(0);
      expect(empty.items).toEqual([]);
      expect(empty.pages).toBe(1);
    } finally {
      db.close();
    }
  });

  it("uses the existing classification rules for joined, nested and malformed evidence", () => {
    const db = fixture();
    try {
      const rows = [
        ['{"item":{"source":"sonarr"}}', "missing required language"],
        ['{"identity":{"source":"radarr"}}', "unknown language"],
        ['{"source":"sonarr"}', "scanner failure"],
        ["broken", "worker recovery or job failure"],
        ["null", "unmapped path"],
        [
          '{"item":{"source":"invalid"},"identity":{"source":"sonarr"}}',
          "missing required language",
        ],
      ];
      rows.forEach(([evidence, reason], i) =>
        db
          .prepare("INSERT INTO attention VALUES (?, ?, ?, ?, ?, ?)")
          .run(String(i), String(i), reason, evidence, "open", "2026-09-25"),
      );
      db.prepare("INSERT INTO media_items VALUES (?, ?, ?)").run(
        "0",
        "Joined title",
        "radarr",
      );
      db.prepare("INSERT INTO jobs VALUES (?, ?)").run(
        "3",
        '{"source":"sonarr"}',
      );
      db.prepare("INSERT INTO operations VALUES (?, ?)").run(
        "4",
        '{"identity":{"source":"radarr"}}',
      );
      const all = attentionQueue(db, new URLSearchParams())
        .items as AttentionItem[];
      expect(all.map((row) => attentionDetails(row).media)).toEqual([
        "movies",
        "movies",
        "tv",
        "tv",
        "movies",
        "tv",
      ]);
      for (const reason of [
        "all",
        "wrong-language",
        "needs-analysis",
        "scanner-failure",
        "job-failure",
        "other",
      ]) {
        for (const media of ["all", "movies", "tv"]) {
          const params = new URLSearchParams({ reason, media });
          const expected = filterAttention(all, attentionFilters(params));
          const result = attentionQueue(db, params);
          expect(result.items.map((row) => row.id)).toEqual(
            expected.map((row) => row.id),
          );
          expect(result.total).toBe(expected.length);
        }
      }
    } finally {
      db.close();
    }
  });
});
