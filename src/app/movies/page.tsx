import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import {
  mediaPage,
  mediaParams,
  type PageSearchParams,
} from "@/lib/media-page";
import { MediaView } from "@/components/MediaView";
export default async function Movies({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  if (!(await currentSession())) redirect("/login");
  const result = mediaPage(await mediaParams(searchParams), "radarr");
  return (
    <main>
      <h1>Movies</h1>
      <MediaView {...result} />
    </main>
  );
}
