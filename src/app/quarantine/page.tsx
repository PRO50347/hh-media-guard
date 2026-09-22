import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { raw } from "@/lib/store";
import { QuarantineView } from "@/components/QuarantineView";
export default async function Quarantine() {
  if (!(await currentSession())) redirect("/login");
  const items = raw()
    .prepare("SELECT * FROM quarantines ORDER BY created_at DESC LIMIT 500")
    .all() as {
    id: string;
    original_path: string;
    quarantine_path: string;
    state: string;
    created_at: string;
    evidence: string;
  }[];
  return (
    <main>
      <h1>Quarantine</h1>
      <QuarantineView items={items} />
    </main>
  );
}
