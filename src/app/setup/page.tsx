import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { getSettings } from "@/lib/store";
import { SetupWizard } from "@/components/SetupWizard";
export default async function Setup() {
  if (!(await currentSession())) redirect("/login");
  return (
    <SetupWizard
      settings={getSettings()}
      destructiveEnabled={process.env.ALLOW_DESTRUCTIVE_ACTIONS === "true"}
    />
  );
}
