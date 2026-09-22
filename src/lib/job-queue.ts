import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Job } from "./types";

export interface LeasedJob extends Job {
  leaseToken: string;
}
type Row = {
  id: string;
  kind: Job["kind"];
  state: Job["state"];
  payload: string;
  progress: number;
  attempts: number;
  run_after: string;
  lease_until?: string;
  lease_token?: string;
  current_item?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  total?: number;
  processed?: number;
};

function decode(row: Row): Job {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    payload: row.payload,
    progress: row.progress,
    attempts: row.attempts,
    runAfter: row.run_after,
    leaseUntil: row.lease_until,
    currentItem: row.current_item,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    total: row.total || 0,
    processed: row.processed || 0,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

/** All state changes made by a worker require its unique lease token. */
export class JobQueue {
  constructor(
    private readonly db: Database.Database,
    private readonly clock = Date.now,
    readonly leaseMs = 60_000,
  ) {}
  private now() {
    return new Date(this.clock()).toISOString();
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      | Row
      | undefined;
    return row && decode(row);
  }
  list() {
    return (
      this.db
        .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500")
        .all() as Row[]
    ).map(decode);
  }

  enqueue(kind: Job["kind"], payload: unknown) {
    return this.db
      .transaction(() => {
        const body = JSON.stringify(canonical(payload));
        const prior = this.db
          .prepare(
            "SELECT * FROM jobs WHERE kind=? AND payload=? AND state IN ('queued','running','retrying')",
          )
          .get(kind, body) as Row | undefined;
        if (prior) return decode(prior);
        const id = randomUUID();
        const now = this.now();
        this.db
          .prepare(
            "INSERT INTO jobs(id,kind,state,payload,progress,attempts,run_after,created_at,updated_at) VALUES(?,?,'queued',?,0,0,?,?,?)",
          )
          .run(id, kind, body, now, now, now);
        return this.get(id)!;
      })
      .immediate();
  }

  claim(): LeasedJob | undefined {
    return this.db
      .transaction(() => {
        const now = this.now();
        const row = this.db
          .prepare(
            "SELECT * FROM jobs WHERE state IN ('queued','retrying') AND run_after<=? ORDER BY created_at,id LIMIT 1",
          )
          .get(now) as Row | undefined;
        if (!row) return;
        const token = randomUUID();
        this.db
          .prepare(
            "UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?",
          )
          .run(
            token,
            new Date(this.clock() + this.leaseMs).toISOString(),
            now,
            row.id,
          );
        return { ...this.get(row.id)!, leaseToken: token };
      })
      .immediate();
  }

  heartbeat(job: LeasedJob) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          new Date(this.clock() + this.leaseMs).toISOString(),
          this.now(),
          job.id,
          job.leaseToken,
          this.now(),
        ).changes === 1
    );
  }

  progress(job: LeasedJob, percent: number, item?: string) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET progress=?,current_item=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          Math.max(0, Math.min(100, percent)),
          item || null,
          this.now(),
          job.id,
          job.leaseToken,
          this.now(),
        ).changes === 1
    );
  }

  finish(
    job: LeasedJob,
    state: "completed" | "needs-attention",
    error?: string,
  ) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state=?,progress=100,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          state,
          error || null,
          this.now(),
          job.id,
          job.leaseToken,
          this.now(),
        ).changes === 1
    );
  }

  fail(job: LeasedJob, error: string, permanent = false) {
    if (permanent || job.attempts >= 3)
      return this.finish(job, "needs-attention", error);
    const after = new Date(
      this.clock() + Math.min(3_600_000, 1000 * 2 ** job.attempts),
    ).toISOString();
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state='retrying',run_after=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .run(after, error, this.now(), job.id, job.leaseToken, this.now())
        .changes === 1
    );
  }

  recover() {
    return this.db
      .prepare(
        "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'needs-attention' ELSE 'retrying' END,run_after=?,lease_token=NULL,lease_until=NULL,updated_at=?,error='Worker lease expired; previous result is not trusted.' WHERE state='running' AND (lease_until IS NULL OR lease_until<=?)",
      )
      .run(this.now(), this.now(), this.now()).changes;
  }

  cancel(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('queued','retrying','running')",
        )
        .run(this.now(), id).changes === 1
    );
  }
}
