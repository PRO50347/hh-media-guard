import { expect, it } from "vitest";
import { decideAudio } from "../src/lib/rules";
import { matchingFileEvidence } from "../src/lib/library";
import {
  defaults,
  type AudioTrack,
  type ArrLanguageEvidence,
} from "../src/lib/types";
import { isCommentary } from "../src/lib/language";
const track = (extra: Partial<AudioTrack> = {}): AudioTrack => ({
  index: 0,
  codec: "ac3",
  language: "und",
  title: "Stereo",
  channels: 2,
  bitrate: 192000,
  layout: "stereo",
  isDefault: true,
  isForced: false,
  isCommentary: false,
  isDescriptive: false,
  ...extra,
});
const arr = (source: "sonarr" | "radarr" = "sonarr"): ArrLanguageEvidence => ({
  source,
  entityId: 4,
  fileId: 10,
  arrPath:
    "/Media/TV SHOW'S/Rugrats (1991)/Season 01/Rugrats - S01E04 - At The Movies.mkv",
  languages: ["English"],
});
it("preserves normal explicitly English decisions regardless of Arr classification", () => {
  expect(
    decideAudio(600, [track({ language: "eng" })], defaults(), {
      ...arr(),
      languages: ["Spanish"],
    }),
  ).toMatchObject({
    decision: "pass",
    languageEvidence: { source: "ffprobe" },
  });
});
it.each(["sonarr", "radarr"] as const)(
  "resolves a Rugrats-style AC3 default und stream with exact %s evidence",
  (source) => {
    expect(decideAudio(600, [track()], defaults(), arr(source))).toMatchObject({
      decision: "pass",
      languageEvidence: {
        source: `${source}-fallback`,
        ffprobeLanguage: "und",
        isDefault: true,
        isCommentary: false,
        isDescriptive: false,
      },
    });
  },
);
it.each([
  { isCommentary: true },
  { title: "Director Commentary" },
  { title: "Bonus audio" },
  { isDescriptive: true },
  { title: "Audio Description" },
  { isForced: true },
  { duration: 30 },
])("does not resolve an ineligible track %j", (extra) => {
  expect(decideAudio(600, [track(extra)], defaults(), arr()).decision).not.toBe(
    "pass",
  );
});
it("allows descriptive fallback only when explicitly accepted", () => {
  expect(
    decideAudio(
      600,
      [track({ isDescriptive: true })],
      { ...defaults(), allowDescriptive: true },
      arr(),
    ).decision,
  ).toBe("pass");
});
it("does not override an explicitly Spanish main track", () => {
  expect(
    decideAudio(600, [track({ language: "spa" })], defaults(), arr()).decision,
  ).toBe("fail");
  expect(
    decideAudio(
      600,
      [track(), track({ index: 1, language: "spa", isDefault: false })],
      defaults(),
      arr(),
    ).decision,
  ).toBe("needs-analysis");
});
it("keeps absent, unknown and multilingual Arr evidence unresolved", () => {
  for (const evidence of [
    undefined,
    { ...arr(), languages: [] },
    { ...arr(), languages: ["Unknown"] },
    { ...arr(), languages: ["English", "Spanish"] },
  ])
    expect(decideAudio(600, [track()], defaults(), evidence).decision).toBe(
      "needs-analysis",
    );
});
it("requires an unambiguous candidate even with a default track", () => {
  expect(
    decideAudio(
      600,
      [track(), track({ index: 1, isDefault: false })],
      defaults(),
      arr(),
    ).decision,
  ).toBe("needs-analysis");
});
it("does not infer anything without program duration", () => {
  expect(decideAudio(undefined, [track()], defaults(), arr()).decision).toBe(
    "needs-analysis",
  );
});
it.each([
  { entityId: 99 },
  { fileId: 99 },
  { source: "radarr" as const },
  { arrPath: "/other.mkv" },
])("rejects exact-file evidence mismatch %j", (extra) => {
  const evidence = arr();
  expect(
    matchingFileEvidence({
      ...evidence,
      title: "fixture",
      languageEvidence: { ...evidence, ...extra },
    }),
  ).toBeUndefined();
});
it("keeps existing commentary title detection", () => {
  expect(isCommentary("Director's Commentary")).toBe(true);
  expect(isCommentary("Stereo")).toBe(false);
});
it("does not reinterpret unrecognized explicit language tags as missing metadata", () => {
  expect(
    decideAudio(
      600,
      [track({ language: "und", rawLanguage: "qaa" })],
      defaults(),
      arr(),
    ).decision,
  ).toBe("needs-analysis");
});
