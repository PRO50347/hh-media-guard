import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { ScanControls } from "@/components/ScanControls";
import {
  mediaPage,
  mediaParams,
  type PageSearchParams,
} from "@/lib/media-page";
import { MediaView } from "@/components/MediaView";
export default async function Library({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  if (!(await currentSession())) redirect("/login");
  const result = mediaPage(await mediaParams(searchParams));
  return (
    <main>
      <h1>Library audit</h1>
      <ScanControls />
      <h2>All media</h2>
      <MediaView {...result} />
    </main>
  );
}
