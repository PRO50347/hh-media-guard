export type RemediationControl = {
  mediaId: string;
  eligible: boolean;
  retryOperationId?: string;
  reason?: string;
  disabledReason?: string;
  state:
    | "Ready"
    | "Fixing"
    | "Replacement pending"
    | "Needs attention"
    | "Complete";
};

export function remediationState(state?: string): RemediationControl["state"] {
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
