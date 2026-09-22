import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listMediaItems } from "@/lib/store";
import { MediaView } from "@/components/MediaView";
export default async function Movies() {
  if (!(await currentSession())) redirect("/login");
  return (
    <main>
      <h1>Movies</h1>
      <MediaView items={listMediaItems("radarr")} />
    </main>
  );
}
