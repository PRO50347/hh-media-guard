import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { getSettings, stats, recentEvents, raw } from "@/lib/store";
export const dynamic = "force-dynamic";
export default async function Dashboard() {
  if (!(await currentSession())) redirect("/login");
  const settings = getSettings();
  const totals = stats();
  const count = (sql: string) =>
    (raw().prepare(sql).get() as { count: number }).count;
  const metrics = [
    ["Total scanned", totals.total, "/library"],
    ["Verified", totals.pass, "/library?status=pass"],
    [
      "Wrong language",
      totals.fail,
      "/attention?reason=wrong-language&status=open",
    ],
    [
      "Needs analysis",
      totals.analysis,
      "/attention?reason=needs-analysis&status=open",
    ],
    [
      "Needs attention",
      count("SELECT COUNT(*) count FROM attention WHERE state='open'"),
      "/attention?status=open",
    ],
    [
      "Quarantined",
      count("SELECT COUNT(*) count FROM quarantines WHERE state='quarantined'"),
      "/quarantine",
    ],
  ] as const;
  return (
    <main>
      <p className="eyebrow">
        {settings.showSuite ? settings.suiteName : "Library health"}
      </p>
      <h1>{settings.appName}</h1>
      {!settings.setupComplete && (
        <p className="notice">
          Complete your configuration in the{" "}
          <Link href="/setup">setup wizard</Link>.
        </p>
      )}
      <div className="metrics">
        {metrics.map(([label, value, href]) => (
          <Link className="metric metric-link" key={label} href={href}>
            <span>{label}</span>
            <b>{value}</b>
            <span className="metric-hint">View items →</span>
          </Link>
        ))}
      </div>
      <div className="actions">
        <Link className="button" href="/library">
          Scan media
        </Link>
        <Link className="button" href="/jobs">
          View background jobs
        </Link>
      </div>
      <section className="card">
        <h2>Recent activity</h2>
        {recentEvents().length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Activity</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents()
                  .slice(0, 15)
                  .map((event, index) => (
                    <tr key={index}>
                      <td>{event.created_at}</td>
                      <td>{event.type}</td>
                      <td>{event.detail}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">
            No activity yet. Configure an integration or scan a mapped test
            file.
          </p>
        )}
      </section>
    </main>
  );
}
