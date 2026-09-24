import { expect, it, vi } from "vitest";
import { decideAudio } from "../src/lib/rules";
// These rule/identity tests do not use persistence.
vi.mock("../src/lib/store", () => ({ listMappings: () => [] }));
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
it.each(["sonarr", "radarr"] as const)(
  "uses %s exact-file metadata before ffprobe",
  (source) => {
    for (const languages of [
      ["English"],
      ["English", "Spanish"],
      ["Unknown", "English"],
    ]) {
      for (const language of ["und", "eng", "spa"]) {
        const result = decideAudio(600, [track({ language })], defaults(), {
          ...arr(source),
          languages,
        });
        expect(result).toMatchObject({
          decision: "pass",
          languageEvidence: { source },
        });
        expect(result.reason).not.toContain("unknown");
      }
    }
    for (const language of ["und", "eng", "deu"]) {
      expect(
        decideAudio(600, [track({ language })], defaults(), {
          ...arr(source),
          languages: ["German"],
        }),
      ).toMatchObject({
        decision: "fail",
        reason: `${source === "sonarr" ? "Sonarr" : "Radarr"} reports no required eng audio in this exact file.`,
      });
    }
  },
);
it.each([undefined, [], ["Unknown"], ["und"]])(
  "uses ffprobe when Arr language is unusable: %j",
  (languages) => {
    const evidence = languages ? { ...arr(), languages } : undefined;
    expect(
      decideAudio(600, [track({ language: "eng" })], defaults(), evidence)
        .decision,
    ).toBe("pass");
    expect(
      decideAudio(600, [track({ language: "deu" })], defaults(), evidence)
        .decision,
    ).toBe("fail");
    expect(decideAudio(600, [track()], defaults(), evidence).decision).toBe(
      "needs-analysis",
    );
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
it("does not make known file language unknown because multiple tracks are untagged", () => {
  expect(
    decideAudio(
      600,
      [track(), track({ index: 1, isDefault: false })],
      defaults(),
      arr(),
    ).decision,
  ).toBe("pass");
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
it("uses known Arr language even when ffprobe has an unrecognized tag", () => {
  expect(
    decideAudio(
      600,
      [track({ language: "und", rawLanguage: "qaa" })],
      defaults(),
      arr(),
    ).decision,
  ).toBe("pass");
});
