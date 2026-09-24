import { normalizeLanguage, isCommentary, isDescriptive } from "./language";
import type {
  AudioTrack,
  Decision,
  Settings,
  ArrLanguageEvidence,
  LanguageEvidence,
} from "./types";
export function decideAudio(
  duration: number | undefined,
  tracks: AudioTrack[],
  policy: Pick<
    Settings,
    | "requiredLanguages"
    | "allowDescriptive"
    | "ignoreCommentary"
    | "requireMainProgram"
    | "unknownBehavior"
  >,
  arr?: ArrLanguageEvidence,
): { decision: Decision; reason: string; languageEvidence?: LanguageEvidence } {
  if (
    !duration ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    tracks.length === 0
  ) {
    return {
      decision: "needs-analysis",
      reason: "Program duration or audio evidence is unavailable.",
    };
  }
  const required = policy.requiredLanguages
    .map(normalizeLanguage)
    .filter((language) => language !== "und");
  const main = tracks.filter(
    (track) =>
      !track.isCommentary &&
      (policy.allowDescriptive || !track.isDescriptive) &&
      (!track.duration || track.duration >= duration * 0.9),
  );
  if (
    main.some((track) => required.includes(normalizeLanguage(track.language)))
  ) {
    return {
      decision: "pass",
      reason: `Required main-program audio verified: ${required.join(", ")}`,
      languageEvidence: { source: "ffprobe" },
    };
  }
  // File-level classification cannot identify a track in a multilingual file.
  // Require exactly one eligible unknown track and no explicit contradiction.
  const candidates = main.filter(
    (track) =>
      !track.isForced &&
      !isCommentary(track.title) &&
      (policy.allowDescriptive || !isDescriptive(track.title)),
  );
  const languages = [...new Set(arr?.languages.map(normalizeLanguage) || [])];
  const candidate = candidates[0];
  if (
    arr &&
    candidates.length === 1 &&
    candidate &&
    normalizeLanguage(candidate.language) === "und" &&
    ["", "und", "unknown", "undefined"].includes(
      (candidate.rawLanguage ?? candidate.language).trim().toLowerCase(),
    ) &&
    (candidate.isDefault || tracks.length === 1) &&
    main.every((track) => normalizeLanguage(track.language) === "und") &&
    languages.length === 1 &&
    languages[0] !== "und" &&
    required.includes(languages[0])
  ) {
    return {
      decision: "pass",
      reason: `Required audio resolved by ${arr.source === "sonarr" ? "Sonarr" : "Radarr"} exact-file fallback for missing stream language metadata.`,
      languageEvidence: {
        source: `${arr.source}-fallback`,
        trackIndex: candidate.index,
        ffprobeLanguage: candidate.language,
        arr,
        isDefault: candidate.isDefault,
        isCommentary: candidate.isCommentary,
        isDescriptive: candidate.isDescriptive,
      },
    };
  }
  if (
    !required.length ||
    main.some((track) => normalizeLanguage(track.language) === "und")
  ) {
    return {
      decision: "needs-analysis",
      reason: "Main-program audio has unknown language metadata.",
    };
  }
  return {
    decision: "fail",
    reason: `No acceptable ${required.join("/")} main-program audio track was found.`,
  };
}
