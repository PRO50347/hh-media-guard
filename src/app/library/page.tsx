import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { ScanControls } from "@/components/ScanControls";
export default async function Library() {
  if (!(await currentSession())) redirect("/login");
  return (
    <main>
      <h1>Library audit</h1>
      <ScanControls />
    </main>
  );
}
