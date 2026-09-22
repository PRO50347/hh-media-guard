export type SafetyMode = "monitor" | "quarantine" | "automatic";
export type Decision = "pass" | "fail" | "needs-analysis";
export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "retrying"
  | "needs-attention";
export type MappingSource = "sonarr" | "radarr" | "generic";

export interface AudioTrack {
  index: number;
  codec: string;
  language: string;
  title?: string;
  duration?: number;
  channels?: number;
  layout?: string;
  bitrate?: number;
  isDefault: boolean;
  isForced?: boolean;
  isCommentary: boolean;
  isDescriptive: boolean;
}
export interface ScanResult {
  path: string;
  duration?: number;
  tracks: AudioTrack[];
  decision: Decision;
  reason: string;
  scannedAt: string;
  fingerprint?: string;
}
export interface Settings {
  suiteName: string;
  appName: string;
  shortName: string;
  accent: string;
  theme: "dark" | "light" | "system";
  showSuite: boolean;
  requiredLanguages: string[];
  allowDescriptive: boolean;
  ignoreCommentary: boolean;
  requireMainProgram: boolean;
  unknownBehavior: "needs-analysis" | "fail";
  safetyMode: SafetyMode;
  retryLimit: number;
  retryCooldownMinutes: number;
  setupComplete: boolean;
  quarantinePath?: string;
  iconUrl?: string;
  suiteLinks?: { name: string; url: string; icon: string; enabled: boolean }[];
  scanIntervalHours?: number;
}
export interface PathMapping {
  id: string;
  source: MappingSource;
  arrPath: string;
  containerPath: string;
  mediaType: "tv" | "movies" | "anime" | "kids" | "other";
  enabled: boolean;
}
export interface Job {
  total?: number;
  processed?: number;
  id: string;
  kind: "scan-file" | "scan-library" | "remediate";
  state: JobState;
  payload: string;
  progress: number;
  attempts: number;
  runAfter: string;
  leaseUntil?: string;
  currentItem?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export const defaults = (): Settings => ({
  suiteName: process.env.SUITE_NAME || "H&H Suite",
  appName: process.env.APP_NAME || "H&H Media Guard",
  shortName: "Media Guard",
  accent: "#a78bfa",
  theme: "dark",
  showSuite: true,
  requiredLanguages: ["eng"],
  allowDescriptive: false,
  ignoreCommentary: true,
  requireMainProgram: true,
  unknownBehavior: "needs-analysis",
  safetyMode: "monitor",
  retryLimit: 3,
  retryCooldownMinutes: 60,
  setupComplete: false,
});
