import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { JobQueue } from "../src/lib/job-queue";
import { WorkerRunner } from "../src/lib/worker-runner";

let db: Database.Database;
let now: number;
let queue: JobQueue;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,state TEXT,payload TEXT,progress INTEGER,attempts INTEGER,run_after TEXT,lease_until TEXT,lease_token TEXT,current_item TEXT,error TEXT,created_at TEXT,updated_at TEXT)",
  );
  now = Date.now();
  queue = new JobQueue(db, () => now, 60000);
});
afterEach(() => {
  db.close();
});

describe("worker ownership and recovery", () => {
  it("retries the failing claimed job without touching another queued job", async () => {
    const first = queue.enqueue("scan-file", { path: "/first" });
    now++;
    const second = queue.enqueue("scan-file", { path: "/second" });
    const claim = vi.spyOn(queue, "claim");
    const runner = new WorkerRunner(queue, async () => {
      throw new Error("probe failed");
    });
    await runner.tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(queue.get(first.id)).toMatchObject({
      state: "retrying",
      attempts: 1,
      error: "probe failed",
    });
    expect(queue.get(second.id)).toMatchObject({
      state: "queued",
      attempts: 0,
    });
    await runner.stop();
  });
  it("moves only the claimed job to Needs Attention on its final attempt", async () => {
    const first = queue.enqueue("scan-file", { path: "/first" });
    now++;
    const second = queue.enqueue("scan-file", { path: "/second" });
    db.prepare("UPDATE jobs SET attempts=2 WHERE id=?").run(first.id);
    const runner = new WorkerRunner(queue, async () => {
      throw new Error("third failure");
    });
    await runner.tick();
    expect(queue.get(first.id)?.state).toBe("needs-attention");
    expect(queue.get(second.id)?.state).toBe("queued");
    await runner.stop();
  });
  it("does not claim a second job when claim itself fails", async () => {
    const claim = vi.spyOn(queue, "claim").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn();
    const runner = new WorkerRunner(queue, execute);
    await runner.tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await runner.stop();
    log.mockRestore();
  });
  it("deduplicates equivalent payloads including while retrying", () => {
    const a = queue.enqueue("scan-file", { path: "/a", source: "sonarr" });
    expect(
      queue.enqueue("scan-file", { source: "sonarr", path: "/a" }).id,
    ).toBe(a.id);
    const leased = queue.claim()!;
    queue.fail(leased, "temporary");
    expect(
      queue.enqueue("scan-file", { path: "/a", source: "sonarr" }).id,
    ).toBe(a.id);
  });
  it("waits for backoff before retrying", () => {
    queue.enqueue("scan-file", { path: "/a" });
    const job = queue.claim()!;
    queue.fail(job, "temporary");
    expect(queue.claim()).toBeUndefined();
    now += 2000;
    expect(queue.claim()).toMatchObject({ id: job.id, attempts: 2 });
  });
  it("recovers expired leases and prevents the stale worker from completing", () => {
    queue.enqueue("scan-file", { path: "/a" });
    const stale = queue.claim()!;
    now += 60001;
    expect(queue.recover()).toBe(1);
    const current = queue.claim()!;
    expect(current.leaseToken).not.toBe(stale.leaseToken);
    expect(queue.finish(stale, "completed")).toBe(false);
    expect(queue.fail(stale, "old error")).toBe(false);
    expect(queue.finish(current, "completed")).toBe(true);
  });
  it("recovers legacy jobs lacking a lease and bounds crash retries", () => {
    const job = queue.enqueue("scan-file", { path: "/a" });
    db.prepare("UPDATE jobs SET state='running',attempts=3 WHERE id=?").run(
      job.id,
    );
    queue.recover();
    expect(queue.get(job.id)?.state).toBe("needs-attention");
  });
  it("revokes the lease when cancelled", () => {
    queue.enqueue("scan-file", { path: "/a" });
    const job = queue.claim()!;
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.heartbeat(job)).toBe(false);
    expect(queue.finish(job, "completed")).toBe(false);
    expect(queue.get(job.id)?.state).toBe("cancelled");
  });
  it("serializes ticks and drains active work on shutdown", async () => {
    queue.enqueue("scan-file", { path: "/a" });
    let release!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = new WorkerRunner(queue, execute);
    const a = runner.tick();
    const b = runner.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([a, b, stop]);
    expect(stopped).toBe(true);
    await runner.tick();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
