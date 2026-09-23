import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { raw } from "@/lib/store";
import { AttentionView } from "@/components/AttentionView";
export default async function Attention() {
  if (!(await currentSession())) redirect("/login");
  const items = raw()
    .prepare(
      "SELECT * FROM attention ORDER BY CASE WHEN state='open' THEN 0 ELSE 1 END, created_at DESC LIMIT 500",
    )
    .all() as {
    id: string;
    subject: string;
    reason: string;
    evidence: string;
    state: string;
  }[];
  return (
    <main>
      <h1>Needs Attention</h1>
      <AttentionView items={items} />
    </main>
  );
}
