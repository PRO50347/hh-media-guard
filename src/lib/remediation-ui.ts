export type RemediationControl = {
  mediaId: string;
  eligible: boolean;
  retryOperationId?: string;
  reason?: string;
  disabledReason?: string;
  state:
    | "Checking current file..."
    | "No fix needed — file now passes"
    | "Fresh scan needs analysis"
    | "Old attempt superseded — current file can be fixed normally"
    | "Ready"
    | "Fixing"
    | "Replacement pending"
    | "Needs attention"
    | "Complete";
};

export function remediationState(state?: string): RemediationControl["state"] {
  if (["queued", "running", "retrying", "retry-queued"].includes(state || ""))
    return "Checking current file...";
  if (state === "superseded")
    return "Old attempt superseded — current file can be fixed normally";
  if (state === "no-fix-needed") return "No fix needed — file now passes";
  if (state === "pending") return "Replacement pending";
  if (state === "complete") return "Complete";
  if (
    ["needs-attention", "failed", "cancelled", "completed"].includes(
      state || "",
    )
  )
    return "Needs attention";
  return state ? "Fixing" : "Ready";
}
