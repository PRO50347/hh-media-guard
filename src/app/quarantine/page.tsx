import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { raw } from "@/lib/store";
import { remediationDisabledReason } from "@/lib/manual-remediation";
import { QuarantineView } from "@/components/QuarantineView";
export default async function Quarantine() {
  if (!(await currentSession())) redirect("/login");
  const items = raw()
    .prepare(
      `SELECT q.*, EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.operation_id=o.id
      WHERE o.quarantine_id=q.id AND o.state='complete' AND s.step='verified-replacement'
        AND json_type(q.evidence,'$.retainedIdentity')='object') AS cleanup_ready
      FROM quarantines q ORDER BY q.created_at DESC LIMIT 500`,
    )
    .all() as {
    id: string;
    original_path: string;
    quarantine_path: string;
    state: string;
    created_at: string;
    evidence: string;
    cleanup_ready: number;
  }[];
  return (
    <main>
      <h1>Quarantine</h1>
      <QuarantineView
        items={items}
        cleanupDisabledReason={remediationDisabledReason()}
      />
    </main>
  );
}
