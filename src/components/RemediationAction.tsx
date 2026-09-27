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
      ? "Checking current file..."
      : control?.state;
  if (!control) return null;
  return (
    <div>
      {state !== "Ready" && (
        <p role="status" aria-label="Remediation state">
          {state === "Needs attention"
            ? "Fix unavailable — review operation"
            : state}
        </p>
      )}
      {!control.eligible && state === "Ready" && (
        <p className="muted">
          Fix unavailable — a conclusive wrong-language result and exact Arr
          identity are required.
        </p>
      )}
      {!control.eligible && control.disabledReason && (
        <p className="muted">{control.disabledReason}</p>
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
                    "Fix & Redownload this file? The current file will be freshly checked and a recovery copy preserved. Sonarr/Radarr will delete their exact file, reject the correlated release, and search once for a replacement. The quarantine copy is retained for recovery until a verified replacement and explicit cleanup.",
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
              "Freshly check this file, preserve a recovery copy, and ask Sonarr/Radarr to replace their exact file."}
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
      control?.state === "Checking current file..." ||
      control?.state === "Fixing" ||
      control?.state === "Replacement pending",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router, active]);
}
