import { legacyHistoryParseFailure } from "./remediation-retry";

const reasons = new Set([
  "Operation is not proven pre-mutation; manual inspection required",
  "Retry identity or evidence changed; manual inspection required",
  "Retry proof changed; manual inspection required",
  "Pre-mutation retry proof is no longer valid; manual inspection required",
  "A persisted conclusive failed scan is required. Rescan this file first.",
  "Persisted failed evidence is unavailable.",
  "Failed evidence does not match exact Arr file identity.",
  "Exact Arr file identity does not match persisted media.",
  "Stored evidence is no longer a conclusive failure. Rescan first.",
  "Sonarr history response could not be parsed",
  "Radarr history response could not be parsed",
  "Arr file identity does not match mapped evidence",
  "Current exact-file language evidence is not a conclusive failure",
  "Single-episode identity is required; multi-episode files need manual attention",
  "Ambiguous imported release history",
  "Ambiguous release identity or multi-title download",
  "Disable Arr automatic failed-download redownload before using Automatic mode",
  "Arr redownload settings changed",
  "Arr still reports media at the original path",
  "Arr rescan failed",
  "Arr rescan timed out",
  "Arr command identity is inconsistent",
  "Automatic remediation is disabled",
  "Title is manually ignored",
  "Title replacement retry limit exceeded",
  "Title replacement cooldown is active",
  "The same rejected release returned; manual attention required",
  "Media or policy changed since scanning",
  "Stored evidence is no longer conclusive",
  "Integration is not configured",
  "Media identity or evidence changed after the request. Rescan first.",
]);

/** Never render arbitrary stored errors, transport bodies, paths or credentials. */
export function remediationReason(value: unknown, source?: string) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  if (legacyHistoryParseFailure(message))
    return `${source === "sonarr" ? "Sonarr" : "Radarr"} history response could not be parsed`;
  return reasons.has(message)
    ? message
    : "Remediation needs attention; inspect the operation evidence before retrying.";
}
