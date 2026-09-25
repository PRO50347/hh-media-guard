import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { ScanControls } from "@/components/ScanControls";
import { withRemediation } from "@/lib/manual-remediation";
import { listMediaItems } from "@/lib/store";
import { MediaView } from "@/components/MediaView";
export default async function Library() {
  if (!(await currentSession())) redirect("/login");
  return (
    <main>
      <h1>Library audit</h1>
      <ScanControls />
      <h2>All media</h2>
      <MediaView items={withRemediation(listMediaItems())} />
    </main>
  );
}
