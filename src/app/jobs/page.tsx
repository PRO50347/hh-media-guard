import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { JobsView } from "@/components/JobsView";
export default async function Jobs() {
  if (!(await currentSession())) redirect("/login");
  return (
    <main>
      <h1>Background jobs</h1>
      <JobsView />
    </main>
  );
}
