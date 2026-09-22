"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, json } from "./api";
export function AttentionView({
  items,
}: {
  items: {
    id: string;
    subject: string;
    reason: string;
    evidence: string;
    state: string;
  }[];
}) {
  const [message, setMessage] = useState("");
  const router = useRouter();
  async function act(id: string, action: string) {
    if (
      action !== "rescan" &&
      !confirm(
        `Record a manual ${action} override? Original scan evidence remains unchanged.`,
      )
    )
      return;
    try {
      await api("/api/attention", json("POST", { id, action }));
      setMessage("Action recorded");
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <p>
        Uncertain results never authorize automatic media deletion.{" "}
        <Link href="/settings">Correct mappings or policy →</Link>
      </p>
      <p role="status">{message}</p>
      {items.length ? (
        items.map((item) => (
          <section className="card" key={item.id}>
            <h2>
              {item.reason} <span className="badge">{item.state}</span>
            </h2>
            <p>{item.subject}</p>
            <details>
              <summary>View evidence</summary>
              <pre>{JSON.stringify(JSON.parse(item.evidence), null, 2)}</pre>
            </details>
            <div className="actions">
              <button onClick={() => void act(item.id, "rescan")}>
                Rescan
              </button>
              <button onClick={() => void act(item.id, "accept")}>
                Manually accept
              </button>
              <button onClick={() => void act(item.id, "ignore")}>
                Ignore
              </button>
            </div>
          </section>
        ))
      ) : (
        <p className="card empty">Nothing needs attention.</p>
      )}
    </>
  );
}
