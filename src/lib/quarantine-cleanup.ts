import { raw } from "./store";
import { removeVerifiedQuarantine } from "./quarantine";
import {
  requireRemediationAllowed,
  validateReplacementEvidence,
  type MediaIdentity,
} from "./remediation";
import type { ScanResult } from "./types";

export async function cleanupVerifiedQuarantine(id: string) {
  requireRemediationAllowed();
  const proof = () => {
    const row = raw()
      .prepare(
        `SELECT s.result FROM operations o JOIN operation_steps s ON s.operation_id=o.id
      WHERE o.quarantine_id=? AND o.state='complete' AND s.step='verified-replacement'
      ORDER BY s.id DESC LIMIT 1`,
      )
      .get(id) as { result: string } | undefined;
    if (!row)
      throw new Error("A verified PASS replacement is required before cleanup");
    return JSON.parse(row.result) as {
      scan: ScanResult;
      identity: MediaIdentity;
    };
  };
  proof();
  const journal = (name: string) => {
    const op = raw()
      .prepare(
        "SELECT id FROM operations WHERE quarantine_id=? AND state='complete'",
      )
      .get(id) as { id: string } | undefined;
    if (!op)
      throw new Error("A verified PASS replacement is required before cleanup");
    raw()
      .prepare(
        "INSERT INTO operation_steps(operation_id,step,result,created_at) VALUES(?,?,?,?)",
      )
      .run(
        op.id,
        name,
        JSON.stringify({ quarantineId: id }),
        new Date().toISOString(),
      );
  };
  await removeVerifiedQuarantine(
    id,
    async () => {
      requireRemediationAllowed();
      const { scan, identity } = proof();
      await validateReplacementEvidence(scan, identity);
      requireRemediationAllowed();
    },
    () => journal("cleanup-intent"),
  );
  journal("cleanup-complete");
}
