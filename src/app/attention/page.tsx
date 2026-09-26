import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { raw } from "@/lib/store";
import { attentionQueue } from "@/lib/attention-query";
import { attentionRemediation } from "@/lib/manual-remediation";
import { AttentionView } from "@/components/AttentionView";
export default async function Attention({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await currentSession())) redirect("/login");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  const queue = attentionQueue(raw(), params);
  queue.items = queue.items.map((item) => ({
    ...item,
    remediation:
      ["missing required language", "replacement failure"].includes(
        item.reason,
      ) && item.state === "open"
        ? attentionRemediation(item.subject)
        : undefined,
  }));
  return (
    <main>
      <h1>Needs Attention</h1>
      <AttentionView queue={queue} />
    </main>
  );
}
