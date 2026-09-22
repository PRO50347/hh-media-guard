import Database from "better-sqlite3";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { migrationSql } from "../src/lib/store";
import { migrate } from "../src/lib/migrations";
import { backupConfig, restoreConfig } from "../scripts/config-backup.mjs";
describe("v0.1 upgrade and portable backup", () => {
  it("preserves settings, scans, events and rejections through upgrade and restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "media-guard-upgrade-"));
    try {
      const config = path.join(root, "v1");
      await mkdir(config);
      const db = new Database(path.join(config, "media-guard.db"));
      // Schema copied from immutable v0.1.0, including its separate fingerprint index.
      db.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE scans(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL,fingerprint TEXT,decision TEXT NOT NULL,reason TEXT NOT NULL,data TEXT NOT NULL,scanned_at TEXT NOT NULL);
        CREATE UNIQUE INDEX scans_fingerprint ON scans(fingerprint);
        CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE rejections(identity TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);`);
      db.prepare("INSERT INTO settings VALUES(1,?)").run(
        JSON.stringify({
          appName: "Preserved name",
          requiredLanguages: ["eng"],
        }),
      );
      db.prepare(
        "INSERT INTO scans(path,fingerprint,decision,reason,data,scanned_at) VALUES(?,?,?,?,?,?)",
      ).run(
        "/fixture/media.mka",
        "legacy-stamp",
        "pass",
        "English",
        '{"fixture":true}',
        "2026-01-01",
      );
      db.prepare(
        "INSERT INTO events(type,detail,created_at) VALUES(?,?,?)",
      ).run("scan", "Old event", "2026-01-01");
      db.prepare("INSERT INTO rejections VALUES(?,?,?)").run(
        "old-release",
        2,
        "2026-01-01",
      );
      const original = {
        settings: db.prepare("SELECT * FROM settings").all(),
        scans: db.prepare("SELECT * FROM scans").all(),
        rejections: db.prepare("SELECT * FROM rejections").all(),
      };
      migrate(db, migrationSql);
      migrate(db, migrationSql);
      expect(db.prepare("SELECT * FROM settings").all()).toEqual(
        original.settings,
      );
      expect(db.prepare("SELECT * FROM scans").all()).toEqual(original.scans);
      expect(db.prepare("SELECT * FROM rejections").all()).toEqual(
        original.rejections,
      );
      expect(db.prepare("SELECT * FROM events").get()).toMatchObject({
        detail: "Old event",
        actor: "system",
      });
      const asset = "11111111-1111-4111-8111-111111111111.png";
      await mkdir(path.join(config, "branding"));
      await writeFile(path.join(config, "branding", asset), "fixture asset");
      db.prepare("INSERT INTO branding_assets VALUES(?,?,?)").run(
        "logo",
        asset,
        "image/png",
      );
      db.close();
      const backup = path.join(root, "backup");
      await backupConfig(config, backup);
      const restored = path.join(root, "restored");
      await restoreConfig(backup, restored);
      const verify = new Database(path.join(restored, "media-guard.db"));
      expect(verify.prepare("SELECT * FROM scans").all()).toEqual(
        original.scans,
      );
      expect(verify.prepare("SELECT * FROM rejections").all()).toEqual(
        original.rejections,
      );
      verify.close();
      expect(
        await readFile(path.join(restored, "branding", asset), "utf8"),
      ).toBe("fixture asset");
      await expect(restoreConfig(backup, restored)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await writeFile(path.join(backup, "branding", asset), "tampered");
      await expect(
        restoreConfig(backup, path.join(root, "unsafe")),
      ).rejects.toThrow("checksum");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
