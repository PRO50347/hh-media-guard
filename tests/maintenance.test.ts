import { beforeEach, describe, it, expect } from "vitest";
import { maintenance, recoverOperations } from "../src/lib/maintenance";
import { RuntimeLease } from "../src/lib/runtime-lease";
import { raw, jobQueue, saveSettings } from "../src/lib/store";
beforeEach(() => {
  for (const table of [
    "jobs",
    "attention",
    "operations",
    "quarantines",
    "schedule_state",
    "runtime_lease",
  ])
    raw().prepare(`DELETE FROM ${table}`).run();
  saveSettings({ scanIntervalHours: 0 });
});
describe("startup recovery and scheduling", () => {
  it("never schedules when disabled", () => {
    maintenance(1000);
    expect(jobQueue.list()).toHaveLength(0);
  });
  it("persists next-run time and deduplicates active audit jobs", () => {
    saveSettings({ scanIntervalHours: 1 });
    maintenance(1000);
    maintenance(2000);
    expect(jobQueue.list()).toHaveLength(1);
    const job = jobQueue.claim()!;
    jobQueue.finish(job, "completed");
    maintenance(3600999);
    expect(jobQueue.list()).toHaveLength(1);
    maintenance(3601000);
    expect(jobQueue.list()).toHaveLength(2);
  });
  it("records terminal job failures once without reopening admin overrides", () => {
    const job = jobQueue.enqueue("scan-file", { path: "/fixture" });
    raw()
      .prepare(
        "UPDATE jobs SET state='needs-attention',error='fixture failure' WHERE id=?",
      )
      .run(job.id);
    maintenance();
    raw()
      .prepare("UPDATE attention SET state='ignored' WHERE subject=?")
      .run(job.id);
    maintenance();
    expect(
      raw().prepare("SELECT state FROM attention WHERE subject=?").get(job.id),
    ).toEqual({ state: "ignored" });
  });
  it("interrupted external steps require attention; pending replacements survive", () => {
    for (const state of ["searching", "pending", "complete"])
      raw()
        .prepare(
          "INSERT INTO operations(id,operation_key,source,entity_id,file_id,state,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(state, state, "radarr", 1, 1, state, "{}", "fixture", "fixture");
    raw()
      .prepare("INSERT INTO quarantines VALUES(?,?,?,?,?,?,?)")
      .run(
        "moving",
        "/fixture/a",
        "/fixture/b",
        "{}",
        "moving",
        "fixture",
        null,
      );
    recoverOperations();
    recoverOperations();
    expect(
      raw().prepare("SELECT state FROM operations WHERE id=?").get("searching"),
    ).toEqual({ state: "needs-attention" });
    expect(
      raw().prepare("SELECT state FROM operations WHERE id=?").get("pending"),
    ).toEqual({ state: "pending" });
    expect(
      raw().prepare("SELECT state FROM quarantines WHERE id=?").get("moving"),
    ).toEqual({ state: "needs-attention" });
    expect(raw().prepare("SELECT COUNT(*) count FROM attention").get()).toEqual(
      { count: 2 },
    );
  });
  it("only one runtime may recover operations; expired owners cannot renew or release a successor", () => {
    let time = 0;
    const first = new RuntimeLease(raw(), () => time, 100);
    const second = new RuntimeLease(raw(), () => time, 100);
    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
    time = 101;
    expect(first.valid()).toBe(false);
    expect(second.acquire()).toBe(true);
    expect(first.renew()).toBe(false);
    first.release();
    expect(second.valid()).toBe(true);
    second.release();
    expect(second.valid()).toBe(false);
  });
});
