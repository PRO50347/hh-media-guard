"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, json } from "./api";
export function QuarantineView({
  items,
}: {
  items: {
    id: string;
    original_path: string;
    quarantine_path: string;
    state: string;
    created_at: string;
    evidence: string;
  }[];
}) {
  const [message, setMessage] = useState("");
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <>
      <p>
        Quarantined files are retained for recovery. Restore never overwrites an
        existing replacement. Incomplete operations require inspection of both
        recorded paths.
      </p>
      <p role="status">{message}</p>
      {items.length ? (
        items.map((item) => (
          <section className="card" key={item.id}>
            <h2>
              <span className="badge">{item.state}</span> {item.created_at}
            </h2>
            <p>Original: {item.original_path}</p>
            <p>Quarantine: {item.quarantine_path}</p>
            <details>
              <summary>Decision evidence</summary>
              <pre>{JSON.stringify(JSON.parse(item.evidence), null, 2)}</pre>
            </details>
            <button
              disabled={item.state !== "quarantined"}
              onClick={async () => {
                if (
                  !confirm(
                    "Restore this file to its original mapped path? Existing files will never be overwritten.",
                  )
                )
                  return;
                try {
                  await api("/api/quarantine", json("POST", { id: item.id }));
                  setMessage("File restored");
                  router.refresh();
                } catch (e) {
                  setMessage((e as Error).message);
                  router.refresh();
                }
              }}
            >
              Restore file
            </button>
          </section>
        ))
      ) : (
        <p className="card empty">No files quarantined.</p>
      )}
    </>
  );
}
