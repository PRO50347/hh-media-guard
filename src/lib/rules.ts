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
      !isCommentary(track.title) &&
      !track.isForced &&
      (policy.allowDescriptive ||
        (!track.isDescriptive && !isDescriptive(track.title))) &&
      (!track.duration || track.duration >= duration * 0.9),
  );
  const languages = [
    ...new Set((arr?.languages || []).map(normalizeLanguage)),
  ].filter((language) => language !== "und");
  if (arr && languages.length && required.length) {
    const service = arr.source === "sonarr" ? "Sonarr" : "Radarr";
    const present = languages.some((language) => required.includes(language));
    return {
      decision: present && main.length ? "pass" : "fail",
      reason: !present
        ? `${service} reports no required ${required.join("/")} audio in this exact file.`
        : !main.length
          ? `${service} reports required audio, but no eligible main-program audio track was found (commentary, descriptive, forced or short audio excluded).`
          : `${service} reports required ${required.join("/")} audio in this exact file.`,
      languageEvidence: {
        source: arr.source,
        arr,
        ffprobeLanguage: tracks.map((track) => track.language).join(", "),
      },
    };
  }
  const known = main
    .map((track) => normalizeLanguage(track.language))
    .filter((language) => language !== "und");
  if (
    required.length &&
    known.some((language) => required.includes(language))
  ) {
    return {
      decision: "pass",
      reason: `Required main-program audio verified by ffprobe: ${required.join(", ")}`,
      languageEvidence: { source: "ffprobe" },
    };
  }
  if (!required.length || (main.length && !known.length)) {
    return {
      decision: "needs-analysis",
      reason:
        "Neither Arr nor ffprobe provides usable main-program language metadata.",
      languageEvidence: { source: "ffprobe" },
    };
  }
  return {
    decision: "fail",
    reason: `No acceptable ${required.join("/")} main-program audio track was found by ffprobe.`,
    languageEvidence: { source: "ffprobe" },
  };
}
