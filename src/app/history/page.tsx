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
              {scan.languageEvidence && (
                <dl>
                  <dt>Language source</dt>
                  <dd>
                    {scan.languageEvidence.source === "sonarr"
                      ? "Sonarr exact-file metadata"
                      : scan.languageEvidence.source === "radarr"
                        ? "Radarr exact-file metadata"
                        : scan.languageEvidence.source}
                  </dd>
                  {scan.languageEvidence.arr && (
                    <>
                      <dt>Arr file language</dt>
                      <dd>{scan.languageEvidence.arr.languages.join(", ")}</dd>
                      <dt>ffprobe language (diagnostic)</dt>
                      <dd>{scan.languageEvidence.ffprobeLanguage}</dd>
                      {scan.languageEvidence.trackIndex !== undefined && (
                        <>
                          <dt>Audio track</dt>
                          <dd>{scan.languageEvidence.trackIndex}</dd>
                          <dt>Default / commentary / descriptive</dt>
                          <dd>
                            {[
                              scan.languageEvidence.isDefault,
                              scan.languageEvidence.isCommentary,
                              scan.languageEvidence.isDescriptive,
                            ]
                              .map((v) => (v ? "yes" : "no"))
                              .join(" / ")}
                          </dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
              )}
              <details>
                <summary>ffprobe and decision details</summary>
                <pre>{JSON.stringify(scan, null, 2)}</pre>
              </details>
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
