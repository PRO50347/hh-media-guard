import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
/** One application runtime owns destructive recovery for a config database. */
export class RuntimeLease {
  readonly owner = randomUUID();
  constructor(
    private db: Database.Database,
    private clock = Date.now,
    readonly ttl = 30000,
  ) {}
  acquire() {
    return (
      this.db
        .prepare(
          "INSERT INTO runtime_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE runtime_lease.expires_at<=?",
        )
        .run(this.owner, this.clock() + this.ttl, this.clock()).changes === 1
    );
  }
  valid() {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM runtime_lease WHERE id=1 AND owner=? AND expires_at>?",
        )
        .get(this.owner, this.clock()),
    );
  }
  renew() {
    return (
      this.db
        .prepare(
          "UPDATE runtime_lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?",
        )
        .run(this.clock() + this.ttl, this.owner, this.clock()).changes === 1
    );
  }
  release() {
    this.db
      .prepare("DELETE FROM runtime_lease WHERE id=1 AND owner=?")
      .run(this.owner);
  }
}
let runtime: RuntimeLease | undefined;
export function attachRuntimeLease(lease: RuntimeLease) {
  runtime = lease;
}
export function requireRuntimeOwnership() {
  if (runtime && !runtime.valid())
    throw new Error("Application runtime lease was lost; mutations refused");
}
