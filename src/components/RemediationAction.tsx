"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { api, json } from "./api";
import type { RemediationControl } from "@/lib/remediation-ui";

export function RemediationAction({
  control,
}: {
  control?: RemediationControl;
}) {
  const router = useRouter();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const state =
    busy || (submitted && control?.state === "Ready")
      ? "Fixing"
      : control?.state;
  if (!control || (!control.eligible && control.state === "Ready")) return null;
  return (
    <div>
      {state !== "Ready" && (
        <p role="status" aria-label="Remediation state">
          {state}
        </p>
      )}
      {control.reason && <p className="muted">{control.reason}</p>}
      {control.eligible && (
        <>
          <button
            disabled={
              busy ||
              (submitted && control.state === "Ready") ||
              !!control.disabledReason
            }
            aria-describedby={descriptionId}
            onClick={async () => {
              if (
                !confirm(
                  (control.retryOperationId
                    ? "Retry the previously failed operation? The server will recheck that no mutation began, that the active file is unchanged, and that Arr identity still matches. "
                    : "") +
                    "Fix & Redownload this file? The failed file will be quarantined and removed from the active media path. Sonarr/Radarr will reject the correlated release and search for a replacement. The quarantine copy is retained for recovery until a verified replacement and explicit cleanup.",
                )
              )
                return;
              setBusy(true);
              setMessage("");
              try {
                await api(
                  "/api/jobs",
                  json("POST", {
                    kind: "remediate",
                    mediaId: control.mediaId,
                    ...(control.retryOperationId
                      ? { retryOperationId: control.retryOperationId }
                      : {}),
                  }),
                );
                setSubmitted(true);
                router.refresh();
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {control.retryOperationId
              ? "Retry Fix & Redownload"
              : "Fix & Redownload"}
          </button>
          <p id={descriptionId} className="muted">
            {control.disabledReason ||
              "Quarantine this failed file and request a replacement through Sonarr/Radarr."}
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

/** One refresh timer per visible list, even when many files are pending. */
export function useRemediationRefresh(
  controls: (RemediationControl | undefined)[],
) {
  const router = useRouter();
  const active = controls.some(
    (control) =>
      control?.state === "Fixing" || control?.state === "Replacement pending",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router, active]);
}
