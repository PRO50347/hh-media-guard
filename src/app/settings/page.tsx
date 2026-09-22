import Link from "next/link";
import { IntegrationSettings } from "@/components/IntegrationSettings";
import { getSettings } from "@/lib/store";
import { currentSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { MappingSettings } from "@/components/MappingSettings";
import { PolicySettings } from "@/components/PolicySettings";

export const dynamic = "force-dynamic";
export default async function Settings() {
  if (!(await currentSession())) redirect("/login");
  const settings = getSettings();
  return (
    <main>
      <Link href="/">← Dashboard</Link>
      <h1>Settings</h1>
      <section className="card">
        <h2>Browser security</h2>
        <p>
          Canonical URL:{" "}
          <code>{process.env.APP_URL || "http://localhost:3938"}</code>
        </p>
        <p>
          Additional allowed origins:{" "}
          <code>{process.env.ALLOWED_ORIGINS || "None"}</code>
        </p>
        <p className="muted">
          These trust boundaries are configured through the container
          environment. Restart after changing them.
        </p>
      </section>
      <div className="grid">
        <IntegrationSettings id="sonarr" />
        <IntegrationSettings id="radarr" />
      </div>
      <MappingSettings />
      <PolicySettings
        initial={settings}
        destructiveEnabled={process.env.ALLOW_DESTRUCTIVE_ACTIONS === "true"}
      />
      <AppearanceSettings initial={settings} />
    </main>
  );
}
