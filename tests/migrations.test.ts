import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { migrate } from "../src/lib/migrations";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

describe("migration serialization", () => {
  it("rolls back failed migrations and their version records", () => {
    const db = new Database(":memory:");
    expect(() =>
      migrate(db, ["CREATE TABLE example(id INTEGER)", "invalid SQL"]),
    ).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='example'").get(),
    ).toBeUndefined();
    db.close();
  });
  it("preserves v0.1 audit records while adding actors", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,detail TEXT,created_at TEXT); INSERT INTO events VALUES(1,'scan','fixture','2026-01-01')",
    );
    migrate(db, ["CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY)"]);
    expect(db.prepare("SELECT detail,actor FROM events").get()).toEqual({
      detail: "fixture",
      actor: "system",
    });
    migrate(db, ["CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY)"]);
    expect(db.prepare("SELECT count(*) AS n FROM migrations").get()).toEqual({
      n: 1,
    });
    db.close();
  });
  it("serializes simultaneous startup migrations without duplicate ALTERs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mg-migration-"));
    directories.push(directory);
    const database = join(directory, "test.db");
    const code = `const {workerData,parentPort}=require('node:worker_threads');
      const Database=require('better-sqlite3');
      const migrate=${migrate.toString()};
      const db=new Database(workerData);
      migrate(db,['CREATE TABLE fixture(id INTEGER)','ALTER TABLE fixture ADD COLUMN title TEXT']);
      db.close(); parentPort.postMessage('done');`;
    await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(code, {
              eval: true,
              workerData: database,
            });
            worker.on("error", reject);
            worker.on("exit", (status) =>
              status === 0
                ? resolve()
                : reject(new Error(`Worker exited ${status}`)),
            );
          }),
      ),
    );
    const db = new Database(database);
    expect(db.prepare("SELECT count(*) AS n FROM migrations").get()).toEqual({
      n: 2,
    });
    db.close();
  });
});
