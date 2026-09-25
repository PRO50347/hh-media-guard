import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { withRemediation } from "@/lib/manual-remediation";
import { listMediaItems } from "@/lib/store";
import { MediaView } from "@/components/MediaView";
export default async function TV() {
  if (!(await currentSession())) redirect("/login");
  return (
    <main>
      <h1>TV Shows</h1>
      <MediaView items={withRemediation(listMediaItems("sonarr"))} />
    </main>
  );
}
