import { JobQueue, type LeasedJob } from "./job-queue";

export class WorkerRunner {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(
    private readonly queue: JobQueue,
    private readonly execute: (
      job: LeasedJob,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 750);
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async run() {
    let claimed: LeasedJob | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();
    try {
      this.queue.recover();
      claimed = this.queue.claim();
      if (!claimed) return;
      const owned = claimed;
      heartbeat = setInterval(
        () => {
          try {
            if (!this.queue.heartbeat(owned)) controller.abort();
          } catch {
            controller.abort();
          }
        },
        Math.max(10, Math.floor(this.queue.leaseMs / 3)),
      );
      await this.execute(owned, controller.signal);
      if (!controller.signal.aborted) this.queue.finish(owned, "completed");
    } catch (error) {
      // Never call claim here: the failure belongs to exactly this lease.
      if (claimed)
        this.queue.fail(
          claimed,
          error instanceof Error ? error.message : "Worker failed",
        );
      else console.error(JSON.stringify({ event: "worker.claim_failed" }));
    } finally {
      clearInterval(heartbeat);
    }
  }
}
