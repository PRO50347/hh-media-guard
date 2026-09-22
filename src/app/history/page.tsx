import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { listScans, recentEvents } from "@/lib/store";
export const dynamic = "force-dynamic";
export default async function History() {
  if (!(await currentSession())) redirect("/login");
  const scans = listScans();
  return (
    <main>
      <h1>History</h1>
      <section className="card">
        <h2>Scan evidence</h2>
        {scans.length ? (
          scans.map((scan) => (
            <details key={scan.fingerprint}>
              <summary>
                <span className={"badge " + scan.decision}>
                  {scan.decision}
                </span>{" "}
                {scan.path} — {scan.scannedAt}
              </summary>
              <p>{scan.reason}</p>
              <pre>{JSON.stringify(scan, null, 2)}</pre>
            </details>
          ))
        ) : (
          <p className="empty">No scans yet.</p>
        )}
      </section>
      <section className="card">
        <h2>Audit log</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents().map((event, index) => (
                <tr key={index}>
                  <td>{event.created_at}</td>
                  <td>{event.actor}</td>
                  <td>
                    {event.type}: {event.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
